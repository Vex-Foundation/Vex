import * as intents from "../db/repos/lighter-order-execution-intents.js";
import * as previews from "../db/repos/lighter-order-previews.js";
import * as ocoIntents from "../db/repos/lighter-oco-execution-intents.js";
import * as lifecycleIntents from "../db/repos/lighter-order-lifecycle-intents.js";
import * as onboardingIntents from "../db/repos/lighter-onboarding-intents.js";
import * as keyIntents from "../db/repos/lighter-key-registration-intents.js";
import * as feeIntents from "../db/repos/lighter-fee-authorization-intents.js";
import * as withdrawalIntents from "../db/repos/lighter-withdrawal-intents.js";
import * as claims from "../db/repos/lighter-withdrawal-claims.js";
import { buildCreateApprovalFollowUp } from "../tools/protocols/lighter/handlers/write.js";
import { buildOcoApprovalFollowUp } from "../tools/protocols/lighter/handlers/oco.js";
import { cancelFollowUp, modifyFollowUp, cancelAllFollowUp, closePositionFollowUp } from "../tools/protocols/lighter/handlers/order-lifecycle.js";
import { buildDepositApprovalFollowUp, isConfirmedApprovalRecoveryPending } from "../tools/protocols/lighter/handlers/deposit.js";
import { buildKeyRegistrationApprovalFollowUp } from "../tools/protocols/lighter/handlers/key-registration.js";
import { buildLighterFeeAuthorizationApprovalFollowUp } from "../tools/protocols/lighter/handlers/fee-authorization.js";
import { buildApprovalFollowUp, buildClaimApprovalFollowUp } from "../tools/protocols/lighter/handlers/withdrawal.js";
import type { PreparedActionFollowUp } from "../tools/types.js";
import { resolveInjectedProtocolTool } from "../tools/registry/injected-protocol-tools.js";
import { validatePreparedActionFollowUp, type ValidatedPreparedActionFollowUp } from "../tools/registry/prepared-action-follow-ups.js";
import type { StudioToolCall } from "./admission.js";

function requirePending<T extends { sessionId: string; expiresAt: string | Date }>(
  row: T | null, sessionId: string, pending: (value: T) => boolean,
): T {
  if (!row || row.sessionId !== sessionId || !pending(row)
    || !Number.isFinite(new Date(row.expiresAt).getTime()) || new Date(row.expiresAt).getTime() <= Date.now()) {
    throw new Error("The saved Lighter action is missing, expired, or no longer awaiting approval.");
  }
  return row;
}
function isPending(row: { approvalStatus: string; executionState: string }): boolean {
  return row.approvalStatus === "approval_pending" && row.executionState === "approval_pending";
}

/** Rebuild each card from session-owned durable data, including on resume. */
export async function readStudioPreparedApproval(
  sessionId: string,
  call: StudioToolCall,
): Promise<ValidatedPreparedActionFollowUp | undefined> {
  const target = resolveInjectedProtocolTool(call.name)?.toolId;
  const idKey = target === "lighter.withdraw.claim" ? "claimId" : "intentId";
  const id = call.args[idKey];
  if (Object.keys(call.args).join(",") !== idKey || typeof id !== "string") {
    throw new Error("The prepared Lighter action must identify one exact intent.");
  }
  let source = `${target}.prepare`;
  let candidate: PreparedActionFollowUp;
  switch (target) {
    case "lighter.order.create": {
      const order = await intents.findByIntentId(sessionId, id);
      if (order) {
        const intent = requirePending(order, sessionId, isPending);
        const preview = await previews.findById(sessionId, intent.environment, intent.previewId);
        if (!preview) throw new Error("The saved Lighter order preview is unavailable.");
        candidate = buildCreateApprovalFollowUp(intent, preview);
      } else {
        if (!id.startsWith("lighter-oco-")) throw new Error("The saved Lighter order is unavailable.");
        const intent = requirePending(await ocoIntents.findByIntentId(sessionId, id), sessionId, isPending);
        const [stop, take] = await Promise.all([
          previews.findById(sessionId, intent.environment, intent.stopLossPreviewId),
          previews.findById(sessionId, intent.environment, intent.takeProfitPreviewId),
        ]);
        if (!stop || !take) throw new Error("The saved Lighter protection previews are unavailable.");
        candidate = buildOcoApprovalFollowUp(intent, stop, take);
        source = "lighter.position.protect";
      }
      break;
    }
    case "lighter.order.cancel":
    case "lighter.order.modify":
    case "lighter.order.cancelAll":
    case "lighter.position.close": {
      const [action, build] = ({
        "lighter.order.cancel": ["cancel_one", cancelFollowUp],
        "lighter.order.modify": ["modify", modifyFollowUp],
        "lighter.order.cancelAll": ["cancel_all", cancelAllFollowUp],
        "lighter.position.close": ["close_position", closePositionFollowUp],
      } as const)[target];
      const intent = requirePending(await lifecycleIntents.findByIntentId(sessionId, id), sessionId,
        (row) => isPending(row) && row.actionType === action);
      candidate = build(intent);
      break;
    }
    case "lighter.deposit": {
      const intent = requirePending(await onboardingIntents.findByIntentId(id), sessionId,
        (row) => row.capability === "deposit" && (isPending(row) || isConfirmedApprovalRecoveryPending(row)));
      candidate = buildDepositApprovalFollowUp(intent);
      break;
    }
    case "lighter.fees.approve": {
      const intent = requirePending(await feeIntents.findLighterFeeAuthorizationIntent(id), sessionId, isPending);
      candidate = buildLighterFeeAuthorizationApprovalFollowUp(intent);
      break;
    }
    case "lighter.key.register": {
      const intent = requirePending(await keyIntents.findLighterKeyRegistrationIntent(id), sessionId, isPending);
      candidate = buildKeyRegistrationApprovalFollowUp(intent);
      break;
    }
    case "lighter.withdraw": {
      const intent = requirePending(await withdrawalIntents.findByIntentId(sessionId, id), sessionId, isPending);
      candidate = buildApprovalFollowUp(intent);
      break;
    }
    case "lighter.withdraw.claim": {
      const attempt = requirePending(await claims.findByClaimId(sessionId, id), sessionId, (row) => row.state === "prepared");
      candidate = buildClaimApprovalFollowUp(attempt);
      break;
    }
    default: return undefined;
  }
  const validated = validatePreparedActionFollowUp(source, candidate);
  if (!validated.ok || validated.followUp.toolName !== "execute_tool"
    || validated.followUp.args.toolId !== target || ("claimId" in validated.followUp.args.params ? validated.followUp.args.params.claimId : validated.followUp.args.params.intentId) !== id) {
    throw new Error("The saved Lighter action cannot produce a valid approval card.");
  }
  return validated.followUp;
}
