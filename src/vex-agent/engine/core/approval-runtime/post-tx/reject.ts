/**
 * Approval runtime — post-tx reject / policy-drift side effects.
 *
 * The reject, expire, and B-001 policy-drift paths share one rejection core:
 * the queue + intent were already flipped to `rejected` inside the locked
 * snapshot tx (before any approve CAS), so this module NEVER dispatches a tool
 * and NEVER appends an approved tool-result — the appended message is always
 * `rejected: true`. Every post-decision failure is translated into a
 * `paused_error` flip + `ApprovalPostDecisionError` so the operator can
 * `/retry` to recover.
 */

import { appendMessage } from "../../../events/index.js";
import { refreshBlobTtlForRecentMessages } from "../../../wake/blob-refresh.js";
import logger from "@utils/logger.js";

import { claimResumeContinuation } from "../continuation.js";
import { shortSha256, summarizeErrorForLog, toIsoNow, TOOL_RESULT_EXPIRED_REASON } from "../helpers.js";
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
import { cancelWalletIntentAfterApprovalRejection } from "../../wallet-send-approval.js";

import { flipRunToPausedError, RESUME_CLAIM_ERROR_KIND } from "./recovery.js";

/**
 * Shared rejection side-effects core (reject / expire / B-001 policy-drift):
 * write the structural rejection tool-result, optionally claim+flip the
 * mission run, and translate any post-decision failure into a `paused_error`
 * flip + `ApprovalPostDecisionError`. Returns the claimed continuation (or
 * `null` for a chat session). NEVER dispatches a tool and NEVER appends an
 * approved tool-result — the appended message is always `rejected: true`.
 *
 * `ownerPrefix` lets the caller tag the lease owner (`reject`/`expire`/
 * `policy_drift`); `recoveryEvidence` is folded into the `paused_error` audit.
 */
async function runRejectionSideEffects(
  approvalId: string,
  row: IntentSnapshotRow,
  resolvedAt: string,
  toolResultContent: string,
  ownerPrefix: string,
  recoveryEvidence: Record<string, unknown>,
): Promise<{
  readonly resolvedAt: string;
  readonly sessionId: string;
  readonly missionRunId: string | null;
  readonly continuation: PreparedContinuation | null;
}> {
  const sessionId = row.session_id;
  const missionRunId = row.mission_run_id;
  const toolCallId = row.queue_tool_call_id ?? row.tool_call_id ?? approvalId;

  try {
    // Reject/expire/policy-drift of wallet_send_confirm must kill the
    // underlying wallet intent. Otherwise a later direct confirm call can
    // re-enqueue a thin approval card for the still-pending transfer.
    await cancelWalletIntentAfterApprovalRejection(sessionId, row.queue_tool_call);

    await refreshBlobTtlForRecentMessages(sessionId);

    await appendMessage(
      sessionId,
      {
        role: "tool",
        content: toolResultContent,
        toolCallId,
        timestamp: toIsoNow(),
      },
      {
        source: "tool",
        messageType: "tool_result",
        visibility: "internal",
        payload: { success: false, rejected: true },
      },
    );

    let continuation: PreparedContinuation | null = null;
    if (missionRunId !== null) {
      continuation = await claimResumeContinuation(
        sessionId,
        missionRunId,
        `${ownerPrefix}-${approvalId}`,
      );
      if (continuation === null) {
        throw new ApprovalPostDecisionError(
          approvalId,
          RESUME_CLAIM_ERROR_KIND,
          shortSha256("resume_claim_failed"),
        );
      }
    }

    return { resolvedAt, sessionId, missionRunId, continuation };
  } catch (cause) {
    if (cause instanceof ApprovalPostDecisionError) {
      if (missionRunId !== null) {
        await flipRunToPausedError(approvalId, missionRunId, cause.errorKind, {
          errorHash: cause.errorHash,
          ...recoveryEvidence,
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
      await flipRunToPausedError(approvalId, missionRunId, errSummary.errorKind, {
        errorHash: errSummary.errorHash,
        ...recoveryEvidence,
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
 * Side effects after `rejected_in_tx` snapshot — write the rejection
 * tool-result to transcript, optionally claim+flip the mission run, return
 * the IPC outcome.
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
  const { resolvedAt, sessionId, missionRunId, continuation } =
    await runRejectionSideEffects(
      approvalId,
      snapshot.row,
      snapshot.queueResolvedAt,
      toolResultContent,
      ownerPrefix,
      { reason: snapshot.reason },
    );

  return {
    kind: "rejected",
    approvalId,
    resolvedAt,
    sessionId,
    missionRunId,
    reason: snapshot.reason,
    continuation,
  };
}

/**
 * B-001 — side effects after a `policy_drift_blocked` snapshot. The queue +
 * intent were already flipped to `rejected` inside the locked snapshot tx
 * (before any approve CAS), so this NEVER dispatches a tool, NEVER marks
 * `dispatching`, and NEVER appends an approved tool-result. It writes the
 * structural drift rejection tool-result and resumes the mission run so the
 * agent observes the failed-closed action.
 */
export async function applyPolicyDriftSideEffects(
  approvalId: string,
  snapshot: Extract<ApproveSnapshot, { type: "policy_drift_blocked" }>,
  toolResultContent: string,
): Promise<Extract<ApprovePrepareOutcome, { kind: "policy_drift_blocked" }>> {
  const { resolvedAt, sessionId, missionRunId, continuation } =
    await runRejectionSideEffects(
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
    resolvedAt,
    sessionId,
    missionRunId,
    permissionAtEnqueue: snapshot.permissionAtEnqueue,
    livePermission: snapshot.livePermission,
    continuation,
  };
}
