import * as approvalIntentsRepo from "@vex-agent/db/repos/approval-intents.js";
import * as approvalsRepo from "@vex-agent/db/repos/approvals.js";
import type { LighterOrderLifecycleIntentRow } from "@vex-agent/db/repos/lighter-order-lifecycle-intents.js";
import { ErrorCodes, VexError } from "../../../../errors.js";

const CRITICAL_KEYS = [
  "accountIndex", "actionType", "apiKeyIndex", "clientOrderId", "environment",
  "filledBaseAmount", "initialBaseAmount", "intentId", "marketIndex", "matchHash",
  "orderType", "price", "providerOrderId", "remainingBaseAmount", "side", "summary",
  "timeInForce", "toolId",
] as const;

export async function assertLighterCancelOneApprovalBinding(input: {
  readonly approvalId: string;
  readonly sessionId: string;
  readonly intent: LighterOrderLifecycleIntentRow;
}): Promise<void> {
  const approval = await approvalsRepo.getByIdForSession(input.approvalId, input.sessionId);
  const args = record(approval?.toolCall.args ?? approval?.toolCall.arguments);
  const params = record(args?.params);
  if (
    approval?.status !== "approved" || (approval.toolCall.command ?? approval.toolCall.name) !== "execute_tool"
    || args?.toolId !== "lighter.order.cancel" || Object.keys(params ?? {}).join(",") !== "intentId"
    || params?.intentId !== input.intent.intentId
  ) throw refusal();

  const audit = await approvalIntentsRepo.getByApprovalId(input.approvalId);
  const critical = record(audit?.previewJson.criticalArgs);
  const snapshot = input.intent.providerSnapshotJson;
  if (
    audit?.sessionId !== input.sessionId || audit.decision !== "approved"
    || audit.actionKind !== "external_post" || audit.executionStatus !== "dispatching"
    || audit.previewJson.toolName !== "order.cancel" || audit.previewJson.namespace !== "lighter"
    || Object.keys(critical ?? {}).sort().join(",") !== [...CRITICAL_KEYS].sort().join(",")
    || critical?.toolId !== "lighter.order.cancel" || critical.intentId !== input.intent.intentId
    || critical.actionType !== "cancel_one" || critical.environment !== input.intent.environment
    || critical.accountIndex !== input.intent.accountIndex || critical.apiKeyIndex !== input.intent.apiKeyIndex
    || critical.marketIndex !== input.intent.marketIndex || critical.providerOrderId !== input.intent.providerOrderId
    || critical.clientOrderId !== snapshot.clientOrderId || critical.side !== snapshot.side
    || critical.orderType !== snapshot.type || critical.timeInForce !== snapshot.timeInForce
    || critical.price !== snapshot.price || critical.initialBaseAmount !== snapshot.initialBaseAmount
    || critical.remainingBaseAmount !== snapshot.remainingBaseAmount
    || critical.filledBaseAmount !== snapshot.filledBaseAmount || critical.matchHash !== input.intent.matchHash
    || typeof critical.summary !== "string" || critical.summary.length === 0
  ) throw refusal();
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function refusal(): VexError {
  return new VexError(
    ErrorCodes.LIGHTER_INVALID_REQUEST,
    "Approved Lighter cancellation refused because the approval does not match the exact provider order intent.",
    "Open the matching cancellation approval card or prepare a fresh cancellation.",
  );
}
