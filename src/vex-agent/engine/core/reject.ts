/**
 * `rejectApproval` — back-compat wrapper over the puzzle-5 phase-3
 * `prepareReject` + `runResumeAfterDecision` pair.
 *
 * Existing non-IPC callers expected a single-CAS flip on `approval_queue`
 * and got an `ApprovalItem | null` back. Phase 3 widens the semantics to a
 * full decision lifecycle (intent write + tool-result + lease+flip +
 * background resume). The wrapper preserves the legacy "returns null on
 * CAS miss" shape by mapping the new outcome union onto it, but also
 * awaits the resumed turn loop synchronously when a mission run is in
 * play — that's the legacy behaviour callers and tests expect.
 *
 * IPC handlers should use `prepareReject` directly so the renderer doesn't
 * block on the full resumed turn loop.
 */

import type { ApprovalItem } from "../../db/repos/approvals.js";
import {
  prepareReject,
  runResumeAfterDecision,
} from "./approval-runtime.js";
import logger from "@utils/logger.js";

/**
 * Reject a single pending approval by id.
 *
 * Returns:
 *   - the rejected/cached `ApprovalItem`-shaped object on a successful or
 *     idempotent re-reject, OR
 *   - `null` when the queue CAS missed because the approval was already
 *     approved (legacy callers distinguished "reject applied" from "noop"
 *     by null).
 *
 * Phase 3 additions:
 *   - Tool-result rejection written to transcript.
 *   - Mission run flipped from `paused_approval` → `running` (when a run
 *     is present) and resumed in-process before returning.
 *   - Idempotent — second reject returns cached state instead of throwing.
 */
export async function rejectApproval(
  approvalId: string,
  options: { reason?: string } = {},
): Promise<ApprovalItem | null> {
  const reason = options.reason;
  const outcome = await prepareReject(approvalId, reason);

  switch (outcome.kind) {
    case "rejected": {
      if (outcome.continuation !== null) {
        // Back-compat: await the resumed loop synchronously so callers
        // that previously called approveAndResume/rejectApproval keep their
        // "control returns when the run has settled" semantics.
        await runResumeAfterDecision(outcome.continuation);
      }
      logger.info("engine.reject.ok", {
        approvalId,
        sessionId: outcome.sessionId,
        missionRunId: outcome.missionRunId,
      });
      return synthesizeApprovalItem(
        approvalId,
        "rejected",
        outcome.resolvedAt,
        outcome.sessionId,
        outcome.reason,
      );
    }

    case "cached_rejected":
      logger.info("engine.reject.cached", {
        approvalId,
        decision: outcome.decision,
      });
      return synthesizeApprovalItem(
        approvalId,
        outcome.decision === "rejected_stop" ? "rejected" : outcome.decision,
        outcome.resolvedAt,
        null,
        outcome.reason ?? "",
      );

    case "deferred_busy":
      // The rejection IS recorded (tool-result committed); only the agent wake
      // is outstanding, and a durable resume path owns it. Report the rejection
      // as applied, because it was.
      logger.info("engine.reject.deferred_busy", {
        approvalId,
        sessionId: outcome.sessionId,
        missionRunId: outcome.missionRunId,
      });
      return synthesizeApprovalItem(
        approvalId,
        "rejected",
        outcome.resolvedAt,
        outcome.sessionId,
        outcome.reason,
      );

    case "already_approved":
      logger.warn("engine.reject.already_approved", {
        approvalId,
        missionRunId: outcome.missionRunId,
      });
      return null;
  }
}

/**
 * Build a minimal `ApprovalItem` from the new outcome shape so legacy
 * consumers (return-value readers) stay compatible. The `toolCall` /
 * `reasoning` fields aren't carried in the outcome — callers that need
 * them already hit the `approvals` repo directly. Phase 3 keeps this
 * shape narrow on purpose; phase 8 UI hooks should consume the IPC DTO,
 * not the wrapper return value.
 */
function synthesizeApprovalItem(
  approvalId: string,
  status: "approved" | "rejected" | "pending",
  resolvedAt: string,
  sessionId: string | null,
  reason: string,
): ApprovalItem {
  return {
    id: approvalId,
    toolCall: {},
    reasoning: reason,
    status,
    sessionId,
    toolCallId: null,
    permissionAtEnqueue: "restricted",
    createdAt: resolvedAt,
    resolvedAt,
  };
}
