/**
 * The ORIGIN-AWARE rejection dispatcher - the one place that decides what a
 * decided-but-not-dispatched approval does next.
 *
 * ## Why every generic entry point routes through here
 *
 * Four callers reject an approval without dispatching anything: the expiry
 * branch of `prepareApprove`, its policy-drift branch, `prepareReject`, and
 * `expireApproval` (which the scheduled sweep and the broker's per-waiter timer
 * both call). None of them knows, or should know, which surface enqueued the
 * row. Before this module they all called `applyRejectSideEffects` directly,
 * which appends a TRANSCRIPT TOOL RESULT and claims a resume - correct for an
 * agent approval and actively wrong for a Studio one, where it would wake the
 * backing session's agent for a tool call that agent never made.
 *
 * So the branch lives here, keyed on the row's `origin`, and every generic
 * entry point calls this instead. For `origin = 'agent'` these are the existing
 * functions, called with the existing arguments: no behaviour moved.
 *
 * ## What the Studio branch does, and everything it does not
 *
 * The decision itself already COMMITTED inside the locked snapshot transaction
 * (queue `rejected` + intent `decision`), together with `decision_reason` and,
 * for an owner-driven refusal, `refusal_reason`. That row IS the settlement of
 * a call that never ran. So the Studio branch writes nothing further and only
 * announces it:
 *
 *   NO transcript message   - there is no transcript; the caller is an MCP
 *                             request, not a conversation.
 *   NO `result_message_id`  - the column exists to make a row resumable by an
 *                             agent turn, which must never happen here.
 *   NO continuation claim   - `runResumeAfterDecision` is not involved; the
 *                             emit happens directly, because there is no turn
 *                             to schedule and nothing to hold a lease for.
 *   NO `settlement` write   - `commitStudioSettlementWith` is fenced on
 *                             `dispatching`, which a rejected row never
 *                             reached. Inventing a settlement body for a call
 *                             that did not run would be a fabricated result.
 */

import logger from "@utils/logger.js";

import { emitStudioSettlement } from "@vex-agent/engine/runtime/studio-settlement-bus.js";
import type {
  ApproveSnapshot,
  IntentSnapshotRow,
  RejectSnapshot,
} from "../snapshot.js";
import type {
  ApprovePrepareOutcome,
  RejectPrepareOutcome,
} from "../types.js";
import { applyPolicyDriftSideEffects, applyRejectSideEffects } from "./reject.js";

/**
 * Reject / expire side effects for either origin. `toolResultContent` is only
 * consumed by the agent branch; the Studio branch has nowhere to put prose and
 * says so by ignoring it.
 */
export async function dispatchRejectSideEffects(
  approvalId: string,
  snapshot: Extract<RejectSnapshot, { type: "rejected_in_tx" }>,
  toolResultContent: string,
): Promise<RejectPrepareOutcome> {
  if (snapshot.row.origin !== "studio_mcp") {
    return applyRejectSideEffects(approvalId, snapshot, toolResultContent);
  }
  announceStudioRejection(approvalId, snapshot.row);
  return {
    kind: "rejected",
    approvalId,
    resolvedAt: snapshot.queueResolvedAt,
    sessionId: snapshot.row.session_id,
    missionRunId: null,
    reason: snapshot.reason,
    continuation: null,
  };
}

/**
 * B-001 and its A3 siblings: authority moved between enqueue and approve, the
 * snapshot transaction already failed the approval closed, and nothing
 * dispatched. Same split as above.
 */
export async function dispatchPolicyDriftSideEffects(
  approvalId: string,
  snapshot: Extract<ApproveSnapshot, { type: "policy_drift_blocked" }>,
  toolResultContent: string,
): Promise<Extract<ApprovePrepareOutcome, { kind: "policy_drift_blocked" }>> {
  if (snapshot.row.origin !== "studio_mcp") {
    return applyPolicyDriftSideEffects(approvalId, snapshot, toolResultContent);
  }
  announceStudioRejection(approvalId, snapshot.row);
  return {
    kind: "policy_drift_blocked",
    approvalId,
    resolvedAt: snapshot.queueResolvedAt,
    sessionId: snapshot.row.session_id,
    missionRunId: null,
    permissionAtEnqueue: snapshot.permissionAtEnqueue,
    livePermission: snapshot.livePermission,
    continuation: null,
  };
}

/**
 * Emit AFTER the decision transaction has committed - which it has, by
 * construction: the snapshot transaction is closed before any post-tx side
 * effect runs. A subscriber reading the row by id on this signal therefore sees
 * the decision that produced it.
 */
function announceStudioRejection(
  approvalId: string,
  row: IntentSnapshotRow,
): void {
  logger.info("engine.studio.decision_rejected", {
    approvalId,
    projectId: row.project_id,
  });
  emitStudioSettlement({
    approvalId,
    projectId: row.project_id,
    outcome: "rejected",
  });
}
