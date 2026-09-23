/**
 * The desk lane's PREPARE half (migration 165): the Lighter desk's own Close,
 * Cancel and Long/Short buttons, with no model turn in front of them.
 *
 * It is the agent lane's prepared-action hop
 * (`turn-loop-tool-batch/prepared-follow-up.ts`) with the model removed and
 * nothing else changed: the same prepare handler builds the same durable
 * proposal, the same registry validation admits the same follow-up, the same
 * one-hop dispatch yields the same `pendingApproval` result, and the same
 * enqueue writes the same card. The desk therefore approves exactly what a
 * chat order would have approved; only who asked differs, and the row's
 * `origin` says so.
 *
 * The desk never hands main a tool call: it names a whitelisted prepare tool
 * and its params, and every argument the approved call will carry is authored
 * by the prepare handler's own follow-up. Nothing signs here - the approved
 * dispatch lives in `../post-tx/dispatch-approved/desk.ts`.
 */

import { randomUUID } from "node:crypto";

import { dispatchTool } from "@vex-agent/tools/dispatcher.js";
import type { InternalToolContext } from "@vex-agent/tools/internal/types.js";
import { validatePreparedActionFollowUp } from "@vex-agent/tools/registry/prepared-action-follow-ups.js";
import {
  acquireSessionControlLock,
  gateOnOperatorStopWithClient,
} from "@vex-agent/engine/runtime/lease-and-status.js";
import logger from "@utils/logger.js";

import { assertApprovalActionKind } from "../../turn-loop-tool-batch/approval-stop.js";
import { enqueueApprovalIntentWithGate } from "../enqueue.js";
import { buildResumedApprovalToolContext } from "../post-tx/dispatch-approved/resumed-tool-context.js";

/** The prepare tools a desk button may name. Everything else is refused. */
export const DESK_PREPARE_TOOL_IDS = [
  "lighter.order.preview",
  "lighter.position.protect",
  "lighter.position.close.prepare",
  "lighter.order.cancel.prepare",
  // The account-setup modal's deposit -> key -> fee chain (design: no model
  // turn walks these three; the modal is the consent surface for all three).
  "lighter.deposit.prepare",
  "lighter.key.register.prepare",
  "lighter.fees.approve.prepare",
] as const;
export type DeskPrepareToolId = (typeof DESK_PREPARE_TOOL_IDS)[number];

export type DeskPrepareOutcome =
  | { readonly kind: "enqueued"; readonly approvalId: string }
  | { readonly kind: "refused"; readonly reason: string };

export async function prepareDeskApproval(input: {
  readonly sessionId: string;
  readonly toolId: DeskPrepareToolId;
  readonly params: Record<string, unknown>;
  readonly onProgress?: (stage: "checking_market" | "creating_approval") => void;
}): Promise<DeskPrepareOutcome> {
  if (!DESK_PREPARE_TOOL_IDS.includes(input.toolId)) {
    return { kind: "refused", reason: "This action cannot be prepared from the desk." };
  }
  const timingStart = performance.now();
  // The same hydrated, wallet-aware context the approved dispatch will run
  // under, minus the approval: `restricted` so the approval gate is the one
  // that answers, and no approval id so nothing downstream can mistake the
  // preview for an authorized call.
  const resumed = await buildResumedApprovalToolContext({
    sessionId: input.sessionId,
    missionRunId: null,
    permissionAtEnqueue: "restricted",
  });
  const contextMs = Math.round(performance.now() - timingStart);
  let previewMs = 0;
  let followUpMs = 0;
  const { disposeDispatch, ...base } = resumed;
  const toolContext: InternalToolContext = {
    ...base,
    approved: false,
    approvalId: null,
    sessionPermission: "restricted",
    ...(input.onProgress ? { deskPrepareProgress: input.onProgress } : {}),
    deskPreparation: true,
  };
  try {
    const prepared = await dispatchTool(
      {
        name: "execute_tool",
        args: { toolId: input.toolId, params: input.params },
        toolCallId: `desk-${randomUUID()}`,
      },
      toolContext,
    );
    previewMs = Math.round(performance.now() - timingStart) - contextMs;
    if (!prepared.success) {
      return { kind: "refused", reason: prepared.output };
    }
    if (prepared.preparedActionFollowUp === undefined) {
      logger.warn("engine.desk.prepare_without_follow_up", {
        sessionId: input.sessionId,
        toolId: input.toolId,
      });
      return { kind: "refused", reason: "Vex could not prepare this action. Nothing was sent." };
    }
    const validated = validatePreparedActionFollowUp(input.toolId, prepared.preparedActionFollowUp);
    if (!validated.ok) {
      logger.warn("engine.desk.follow_up_rejected", {
        sessionId: input.sessionId,
        toolId: input.toolId,
        reason: validated.reason,
      });
      return { kind: "refused", reason: "Vex could not prepare this action. Nothing was sent." };
    }
    const followUp = validated.followUp;
    input.onProgress?.("creating_approval");
    const toolCall = {
      id: `prepared-follow-up-${randomUUID()}`,
      name: followUp.toolName,
      arguments: followUp.args,
    };
    const result = await dispatchTool(
      { name: toolCall.name, args: toolCall.arguments, toolCallId: toolCall.id },
      toolContext,
    );
    followUpMs = Math.round(performance.now() - timingStart) - contextMs - previewMs;
    if (result.preparedActionFollowUp !== undefined || !result.pendingApproval) {
      logger.warn("engine.desk.follow_up_not_pending", {
        sessionId: input.sessionId,
        toolId: input.toolId,
        success: result.success,
      });
      return {
        kind: "refused",
        reason: result.success
          ? "Vex could not prepare this action. Nothing was sent."
          : result.output,
      };
    }
    const intentActionKind = assertApprovalActionKind(result, toolCall);
    const enqueued = await enqueueApprovalIntentWithGate(
      {
        sessionId: input.sessionId,
        missionId: null,
        missionRunId: null,
        permission: "restricted",
        toolName: toolCall.name,
        toolArgs: toolCall.arguments,
        toolCallId: toolCall.id,
        result,
        toolContext,
        intentActionKind,
        trustedPreview: followUp.approvalPreview,
        trustedExpiresAt: followUp.expiresAt,
        ...(result.preparedApprovalBinding === undefined
          ? {}
          : { preparedApprovalBinding: result.preparedApprovalBinding }),
        origin: "desk",
      },
      async (client) => {
        await acquireSessionControlLock(client, input.sessionId);
        const stopGate = await gateOnOperatorStopWithClient(client, {
          sessionId: input.sessionId,
          missionRunId: null,
        });
        if (stopGate.kind === "stopped") {
          return { kind: "auto_rejected", runStatus: stopGate.runStatus, logKind: "operator_stop" };
        }
        return { kind: "clear" };
      },
    );
    if (enqueued.kind === "enqueued") return enqueued;
    return {
      kind: "refused",
      reason: enqueued.kind === "refused"
        ? enqueued.reason
        : "The session is stopped. Nothing was sent.",
    };
  } finally {
    logger.info("engine.desk.prepare_timing", {
      toolId: input.toolId,
      contextMs,
      previewMs,
      followUpMs,
      enqueueMs: Math.round(performance.now() - timingStart) - contextMs - previewMs - followUpMs,
      totalMs: Math.round(performance.now() - timingStart),
    });
    disposeDispatch();
  }
}
