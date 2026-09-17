/**
 * Approve side effects for a DESK row (`origin = 'desk'`, migration 164).
 *
 * The Lighter desk's own buttons enqueue these rows with no model turn in
 * front of them (`../../desk/prepare.ts`), so on approve there is no
 * continuation to claim, no transcript tool result to append and no turn to
 * resume. Everything else is the agent lane verbatim: the same resumed tool
 * context, the same dispatch slot under the operator-stop gate, the same
 * manifest-identity and request-digest checks, the same `dispatchTool`, and
 * the same execution-status derivation. The row settles through
 * `commitDeskSettlementWith`, and the outcome rides the approve reply back to
 * the desk.
 *
 * A dispatch that threw, or whose settlement write failed after the call
 * already ran, is `indeterminate` and never retried - the desk must say so
 * rather than invite a second order.
 */

import { withTransaction } from "../../../../../db/client.js";
import * as approvalIntentsRepo from "../../../../../db/repos/approval-intents.js";
import { dispatchTool } from "../../../../../tools/dispatcher.js";
import logger from "@utils/logger.js";

import { extractToolCall, shortSha256, summarizeErrorForLog } from "../../helpers.js";
import type { ApproveSnapshot } from "../../snapshot.js";
import {
  approvalRequestDigestMatches,
  checkApprovalManifestIdentity,
  readApprovalQuoteAuthority,
  readApprovalPrequoteAuthority,
} from "../../tool-call-envelope.js";
import { ApprovalPostDecisionError, type ApprovePrepareOutcome } from "../../types.js";
import { deriveApprovedDispatchExecutionStatus } from "../dispatch-approved.js";
import { buildResumedApprovalToolContext } from "./resumed-tool-context.js";
import { claimDispatchSlotUnderStopGate } from "./dispatch-slot-gate.js";

const DESK_DISPATCH_STOPPED_OUTPUT =
  "Stopped before the order was sent. Nothing was executed and no funds moved.";
const DESK_DISPATCH_UNPROVABLE_OUTPUT =
  "The order could not be completed and Vex cannot prove whether it reached the exchange. "
  + "It will NOT be retried; check the account panel before sending it again.";

export async function applyDeskApproveSideEffects(
  approvalId: string,
  snapshot: Extract<ApproveSnapshot, { type: "approved_in_tx" }>,
): Promise<ApprovePrepareOutcome> {
  const row = snapshot.row;
  const sessionId = row.session_id;
  const fallbackToolCallId = row.queue_tool_call_id ?? row.tool_call_id ?? approvalId;
  const toolCall = extractToolCall(row.queue_tool_call, fallbackToolCallId);

  const toolContext = await buildResumedApprovalToolContext({
    sessionId,
    missionRunId: null,
    permissionAtEnqueue: row.queue_permission_at_enqueue,
    approvalId,
    approvedQuoteAuthority: readApprovalQuoteAuthority(row.queue_tool_call),
    approvedPrequoteAuthority: readApprovalPrequoteAuthority(row.queue_tool_call),
  });

  try {
    const slotGate = await claimDispatchSlotUnderStopGate({
      approvalId,
      sessionId,
      missionRunId: null,
    });
    if (!slotGate.tookSlot) {
      // The decision CAS admits one approver per row, so a taken slot here
      // means the row was already dispatching - there is nothing safe to do.
      throw new ApprovalPostDecisionError(
        approvalId,
        "desk_slot_taken",
        shortSha256("desk_slot_taken"),
      );
    }
    if (slotGate.stopGate.kind === "stopped") {
      return settle(approvalId, snapshot, "failed", {
        success: false,
        output: DESK_DISPATCH_STOPPED_OUTPUT,
      });
    }

    let dispatchResult: {
      success: boolean;
      output: string;
      data?: Record<string, unknown>;
    };
    const identity = checkApprovalManifestIdentity(row.queue_tool_call);
    if (!identity.ok) {
      logger.warn("engine.desk.manifest_identity_refused", {
        approvalId,
        sessionId,
        reason: identity.reason,
      });
      dispatchResult = { success: false, output: identity.refusal };
    } else if (!approvalRequestDigestMatches(row.queue_tool_call, row.request_digest)) {
      logger.warn("engine.desk.request_digest_mismatch", { approvalId, sessionId });
      dispatchResult = {
        success: false,
        output:
          "Approved action refused: the stored request no longer matches the one this approval "
          + "was granted for. Nothing was executed and no funds moved.",
      };
    } else {
      try {
        dispatchResult = await dispatchTool(
          {
            name: toolCall.toolName,
            args: toolCall.toolArgs,
            toolCallId: toolCall.toolCallId,
          },
          toolContext,
        );
      } catch (cause) {
        const summary = summarizeErrorForLog(cause);
        logger.warn("engine.desk.dispatch_threw", {
          approvalId,
          sessionId,
          errorKind: summary.errorKind,
          errorHash: summary.errorHash,
        });
        return settle(approvalId, snapshot, "indeterminate", {
          success: false,
          output: DESK_DISPATCH_UNPROVABLE_OUTPUT,
        }, summary.errorHash);
      }
    }

    return settle(
      approvalId,
      snapshot,
      deriveApprovedDispatchExecutionStatus(dispatchResult),
      dispatchResult,
    );
  } finally {
    toolContext.disposeDispatch();
  }
}

async function settle(
  approvalId: string,
  snapshot: Extract<ApproveSnapshot, { type: "approved_in_tx" }>,
  status: "succeeded" | "failed" | "indeterminate",
  result: { readonly success: boolean; readonly output: string },
  resultHash: string = shortSha256(result.output),
): Promise<ApprovePrepareOutcome> {
  let settledStatus = status;
  try {
    const committed = await withTransaction((client) =>
      approvalIntentsRepo.commitDeskSettlementWith(client, {
        approvalId,
        status,
        resultHash,
      }),
    );
    if (!committed) {
      throw new ApprovalPostDecisionError(
        approvalId,
        "desk_settlement_superseded",
        shortSha256("desk_settlement_superseded"),
      );
    }
  } catch (cause) {
    if (cause instanceof ApprovalPostDecisionError) throw cause;
    // The call already ran; a settlement that will not write leaves an
    // outcome nobody can prove. Say so, and try once to record that much.
    const summary = summarizeErrorForLog(cause);
    logger.error("engine.desk.settlement_write_failed", {
      approvalId,
      status,
      errorKind: summary.errorKind,
      errorHash: summary.errorHash,
    });
    settledStatus = "indeterminate";
    try {
      await withTransaction((client) =>
        approvalIntentsRepo.commitDeskSettlementWith(client, {
          approvalId,
          status: "indeterminate",
          resultHash: summary.errorHash,
        }),
      );
    } catch {
      // Left `dispatching`; process-start recovery marks it indeterminate.
    }
  }
  return {
    kind: "dispatched",
    approvalId,
    resolvedAt: snapshot.queueResolvedAt,
    executionStatus: settledStatus,
    sessionId: snapshot.row.session_id,
    missionRunId: null,
    continuation: null,
    toolResult: { success: result.success, output: result.output },
  };
}
