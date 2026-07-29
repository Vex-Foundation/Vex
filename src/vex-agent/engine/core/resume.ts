/**
 * `approveAndResume` — back-compat wrapper over the puzzle-5 phase-3
 * `prepareApprove` + `runResumeAfterDecision` pair.
 *
 * Existing non-IPC callers (engine tests and direct engine consumers) keep their
 * synchronous-resume semantics: the function awaits the mission-run turn
 * loop and returns the resulting `TurnResult`. IPC handlers should use
 * `prepareApprove` + `dispatchPreparedApprovalDecision(runResumeAfterDecision)`
 * directly to avoid blocking the renderer on a full turn loop (Codex
 * puzzle-5 phase-3 review point 5).
 *
 * Decision shape: all phase-3 outcomes from `prepareApprove` map onto the
 * existing throw semantics that `approveAndResume`'s callers already
 * expect — `cached_approved` collapses to a synthesised "already resolved"
 * `TurnResult` (no re-dispatch), `expired` / `already_rejected` /
 * `run_terminated` throw with the same messages the legacy implementation
 * used.
 */

import { type TurnResult } from "../types.js";
import {
  prepareApprove,
  runResumeAfterDecision,
  discardContinuation,
  ApprovalDispatchError,
} from "./approval-runtime.js";
import logger from "@utils/logger.js";

export async function approveAndResume(
  approvalId: string,
): Promise<TurnResult> {
  let outcome: Awaited<ReturnType<typeof prepareApprove>>;
  try {
    outcome = await prepareApprove(approvalId);
  } catch (cause) {
    if (cause instanceof ApprovalDispatchError) {
      throw cause;
    }
    throw cause;
  }

  switch (outcome.kind) {
    case "dispatched": {
      if (outcome.continuation !== null) {
        logger.info("engine.resume.re_entering_loop", {
          approvalId,
          missionRunId: outcome.missionRunId,
        });
        return await runResumeAfterDecision(outcome.continuation);
      }
      // Chat session — no mission run, no continuation. Return the
      // dispatched tool result as the TurnResult text payload (matches the
      // legacy "no mission run" branch in the original approveAndResume).
      return {
        text: outcome.toolResult.output,
        toolCallsMade: 1,
        pendingApprovals: [],
        stopReason: null,
        missionStatus: null,
      };
    }

    case "cached_approved":
      return {
        text: `Approval ${approvalId} already resolved (executionStatus=${outcome.executionStatus})`,
        toolCallsMade: 0,
        pendingApprovals: [],
        stopReason: null,
        missionStatus: null,
      };

    case "expired": {
      // Auto-rejection has already written tool-result + claim+flip. If it
      // produced a continuation, the back-compat wrapper must consume it
      // (else the lease leaks until TTL) — non-IPC callers that aren't
      // expecting a background dispatch get the chained resume here.
      if (
        outcome.autoRejection.kind === "rejected"
        && outcome.autoRejection.continuation !== null
      ) {
        await runResumeAfterDecision(outcome.autoRejection.continuation);
      }
      throw new Error(
        `Approval ${approvalId} expired at ${outcome.expiresAt} — auto-rejected`,
      );
    }

    case "policy_drift_blocked": {
      // B-001 — live permission drifted more restrictive after enqueue; the
      // action was rejected before dispatch. Mirror the `expired` path: the
      // auto-rejection already wrote tool-result + claim+flip, so consume any
      // continuation here (else the lease leaks) before throwing.
      if (outcome.continuation !== null) {
        await runResumeAfterDecision(outcome.continuation);
      }
      throw new Error(
        `Approval ${approvalId} cannot be applied: session permission became more restrictive ` +
          `(enqueue=${outcome.permissionAtEnqueue}, live=${outcome.livePermission}) — auto-rejected`,
      );
    }

    case "deferred_busy":
      // The decision committed but another runner holds the session lease, so
      // the tool was deliberately NOT dispatched. The approval survives as a
      // durable pending resume; this synchronous wrapper simply reports that
      // nothing ran rather than pretending it did.
      logger.info("engine.resume.deferred_busy", {
        approvalId,
        sessionId: outcome.sessionId,
        missionRunId: outcome.missionRunId,
      });
      return {
        text: null,
        toolCallsMade: 0,
        pendingApprovals: [approvalId],
        stopReason: null,
        missionStatus: null,
      };

    case "already_rejected":
      throw new Error(
        `Approval ${approvalId} cannot be applied: already ${outcome.decision}`,
      );

    case "run_terminated":
      throw new Error(
        `Approval ${approvalId} cannot be applied: mission run ${outcome.missionRunId} is ${outcome.runStatus}`,
      );
  }
}

// Re-export the error so legacy callers can `instanceof`-check it.
export { ApprovalDispatchError } from "./approval-runtime.js";

// Defensive cleanup re-export — back-compat callers don't use this, but
// keeping it accessible via the resume module surface mirrors the
// continuation lifecycle responsibilities.
export { discardContinuation };
