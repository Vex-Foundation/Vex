/**
 * Approval runtime — post-tx reject / policy-drift side effects.
 *
 * The reject, expire, and B-001 policy-drift paths share one rejection core:
 * the queue + intent were already flipped to `rejected` inside the locked
 * snapshot tx (before any approve CAS), so this module NEVER dispatches a tool
 * and NEVER appends an approved tool-result — the appended message is always
 * `rejected: true`.
 *
 * Two things changed with the lifecycle work:
 *
 *   - the rejection tool-result is committed together with `result_message_id`,
 *     so a rejection is a durable pending resume exactly like an approval;
 *   - a busy lease is `deferred_busy` rather than `paused_error`. The
 *     rejection is already recorded and unconsumed, so the reconciler will
 *     wake the agent; flipping the run to `paused_error` would have demanded a
 *     manual `/retry` for something the runtime can finish by itself.
 *
 * A run that has left the resumable statuses entirely is still escalated —
 * that is not transient, and deferring it would loop forever.
 */

import logger from "@utils/logger.js";

import { claimResumeContinuation } from "../continuation.js";
import { scheduleDeferredResumeRetries } from "../deferred-resume.js";
import {
  shortSha256,
  summarizeErrorForLog,
  TOOL_RESULT_EXPIRED_REASON,
} from "../helpers.js";
import type {
  ApproveSnapshot,
  IntentSnapshotRow,
  RejectSnapshot,
} from "../snapshot.js";
import {
  ApprovalPostDecisionError,
  type ApprovePrepareOutcome,
  type PreparedContinuation,
  type RejectPrepareOutcome,
} from "../types.js";

import { flipRunToPausedError, RESUME_CLAIM_ERROR_KIND } from "./recovery.js";
import { commitDecisionToolResult } from "./result-message.js";

interface RejectionSideEffects {
  readonly resolvedAt: string;
  readonly sessionId: string;
  readonly missionRunId: string | null;
  /** `null` when the resume was deferred — see `deferred`. */
  readonly continuation: PreparedContinuation | null;
  /** The rejection is recorded; only the agent wake is outstanding. */
  readonly deferred: boolean;
}

/**
 * Shared rejection side-effects core (reject / expire / B-001 policy-drift):
 * commit the structural rejection tool-result together with its
 * `result_message_id`, claim the continuation, and translate any post-decision
 * failure into a `paused_error` flip + `ApprovalPostDecisionError`. NEVER
 * dispatches a tool and NEVER appends an approved tool-result.
 *
 * `ownerPrefix` tags the lease owner (`reject`/`expire`/`policy_drift`);
 * `recoveryEvidence` is folded into the `paused_error` audit.
 */
async function runRejectionSideEffects(
  approvalId: string,
  row: IntentSnapshotRow,
  resolvedAt: string,
  toolResultContent: string,
  ownerPrefix: string,
  recoveryEvidence: Record<string, unknown>,
): Promise<RejectionSideEffects> {
  const sessionId = row.session_id;
  const missionRunId = row.mission_run_id;
  const toolCallId = row.queue_tool_call_id ?? row.tool_call_id ?? approvalId;

  try {
    await commitDecisionToolResult({
      approvalId,
      sessionId,
      toolCallId,
      content: toolResultContent,
      payload: { success: false, rejected: true },
    });

    const claim = await claimResumeContinuation({
      sessionId,
      missionRunId,
      approvalId,
      ownerPrefix,
    });
    if (claim.outcome === "busy") {
      logger.info("engine.approval_runtime.reject_deferred_busy", {
        approvalId,
        sessionId,
        missionRunId,
        side: ownerPrefix,
      });
      scheduleDeferredResumeRetries(sessionId);
      return {
        resolvedAt,
        sessionId,
        missionRunId,
        continuation: null,
        deferred: true,
      };
    }
    if (claim.outcome === "status_mismatch") {
      throw new ApprovalPostDecisionError(
        approvalId,
        RESUME_CLAIM_ERROR_KIND,
        shortSha256("resume_claim_failed"),
      );
    }

    return {
      resolvedAt,
      sessionId,
      missionRunId,
      continuation: claim.continuation,
      deferred: false,
    };
  } catch (cause) {
    if (cause instanceof ApprovalPostDecisionError) {
      if (missionRunId !== null) {
        await flipRunToPausedError({
          approvalId,
          sessionId,
          missionRunId,
          errorKind: cause.errorKind,
          evidence: { errorHash: cause.errorHash, ...recoveryEvidence },
        });
      }
      throw cause;
    }
    const errSummary = summarizeErrorForLog(cause);
    logger.warn("engine.approval_runtime.post_decision_failed", {
      approvalId,
      sessionId,
      missionRunId,
      errorKind: errSummary.errorKind,
      errorHash: errSummary.errorHash,
      side: ownerPrefix,
    });
    if (missionRunId !== null) {
      await flipRunToPausedError({
        approvalId,
        sessionId,
        missionRunId,
        errorKind: errSummary.errorKind,
        evidence: { errorHash: errSummary.errorHash, ...recoveryEvidence },
      });
    }
    throw new ApprovalPostDecisionError(
      approvalId,
      errSummary.errorKind,
      errSummary.errorHash,
    );
  }
}

/**
 * Side effects after `rejected_in_tx` snapshot — commit the rejection
 * tool-result, claim the continuation, return the IPC outcome.
 *
 * `toolResultContent` is built by the caller because the reject path and
 * the expire path render different messages even though the snapshot type
 * is the same.
 */
export async function applyRejectSideEffects(
  approvalId: string,
  snapshot: Extract<RejectSnapshot, { type: "rejected_in_tx" }>,
  toolResultContent: string,
): Promise<RejectPrepareOutcome> {
  const ownerPrefix =
    snapshot.reason === TOOL_RESULT_EXPIRED_REASON ? "expire" : "reject";
  const effects = await runRejectionSideEffects(
    approvalId,
    snapshot.row,
    snapshot.queueResolvedAt,
    toolResultContent,
    ownerPrefix,
    { reason: snapshot.reason },
  );

  if (effects.deferred) {
    return {
      kind: "deferred_busy",
      approvalId,
      resolvedAt: effects.resolvedAt,
      sessionId: effects.sessionId,
      missionRunId: effects.missionRunId,
      reason: snapshot.reason,
    };
  }

  return {
    kind: "rejected",
    approvalId,
    resolvedAt: effects.resolvedAt,
    sessionId: effects.sessionId,
    missionRunId: effects.missionRunId,
    reason: snapshot.reason,
    continuation: effects.continuation,
  };
}

/**
 * B-001 — side effects after a `policy_drift_blocked` snapshot. The queue +
 * intent were already flipped to `rejected` inside the locked snapshot tx
 * (before any approve CAS), so this NEVER dispatches a tool, NEVER marks
 * `dispatching`, and NEVER appends an approved tool-result. It commits the
 * structural drift rejection tool-result and resumes the agent so it observes
 * the failed-closed action.
 */
export async function applyPolicyDriftSideEffects(
  approvalId: string,
  snapshot: Extract<ApproveSnapshot, { type: "policy_drift_blocked" }>,
  toolResultContent: string,
): Promise<Extract<ApprovePrepareOutcome, { kind: "policy_drift_blocked" }>> {
  const effects = await runRejectionSideEffects(
    approvalId,
    snapshot.row,
    snapshot.queueResolvedAt,
    toolResultContent,
    "policy_drift",
    {
      reason: snapshot.reason,
      permissionAtEnqueue: snapshot.permissionAtEnqueue,
      livePermission: snapshot.livePermission,
    },
  );

  return {
    kind: "policy_drift_blocked",
    approvalId,
    resolvedAt: effects.resolvedAt,
    sessionId: effects.sessionId,
    missionRunId: effects.missionRunId,
    permissionAtEnqueue: snapshot.permissionAtEnqueue,
    livePermission: snapshot.livePermission,
    continuation: effects.continuation,
  };
}
