import { lighterOrderFeeCriticalArgs } from "@tools/lighter/order-fee-terms.js";
import * as approvalIntentsRepo from "@vex-agent/db/repos/approval-intents.js";
import * as approvalsRepo from "@vex-agent/db/repos/approvals.js";
import type { LighterOrderExecutionIntentRow } from "@vex-agent/db/repos/lighter-order-execution-intents.js";

import { ErrorCodes, VexError } from "../../../../errors.js";

const REFUSAL =
  "Approved Lighter order create refused because the approval record does not match the prepared execution intent. No order was signed or submitted.";

const CRITICAL_ARG_KEYS = [
  "accountIndex",
  "apiKeyIndex",
  "baseAmountDisplay",
  "baseAmountInteger",
  "environment",
  "intentId",
  "marketIndex",
  "marketSymbol",
  "marketType",
  "matchHash",
  "notionalDisplay",
  "orderExpiryIso",
  "orderSummary",
  "orderType",
  "previewId",
  "priceDisplay",
  "priceInteger",
  "triggerPriceDisplay",
  "triggerPriceInteger",
  "reduceOnly",
  "side",
  "timeInForce",
  "toolId",
] as const;
const LEGACY_CRITICAL_ARG_KEYS = CRITICAL_ARG_KEYS.filter(
  (key) => key !== "triggerPriceDisplay" && key !== "triggerPriceInteger",
);

export async function assertLighterOrderCreateApprovalBinding(input: {
  readonly approvalId: string;
  readonly sessionId: string;
  readonly intent: LighterOrderExecutionIntentRow;
}): Promise<void> {
  const approval = await approvalsRepo.getByIdForSession(input.approvalId, input.sessionId);
  if (
    approval === null
    || approval.status !== "approved"
    || !toolCallTargetsIntent(approval.toolCall, input.intent.intentId)
  ) {
    throw refusal();
  }

  const auditIntent = await approvalIntentsRepo.getByApprovalId(input.approvalId);
  if (
    auditIntent === null
    || auditIntent.sessionId !== input.sessionId
    || auditIntent.decision !== "approved"
    || auditIntent.actionKind !== "external_post"
    || auditIntent.executionStatus !== "dispatching"
    || !approvalPreviewMatchesIntent(auditIntent.previewJson, input.intent)
  ) {
    throw refusal();
  }
}

function toolCallTargetsIntent(
  toolCall: Record<string, unknown>,
  intentId: string,
): boolean {
  const command = toolCall.command ?? toolCall.name;
  if (command !== "execute_tool") return false;

  const args = readRecord(toolCall.args ?? toolCall.arguments);
  if (args === null || args.toolId !== "lighter.order.create") return false;

  const params = readRecord(args.params);
  if (params === null) return false;
  return (
    Object.keys(params).join(",") === "intentId"
    && params.intentId === intentId
  );
}

function approvalPreviewMatchesIntent(
  previewJson: Record<string, unknown>,
  intent: LighterOrderExecutionIntentRow,
): boolean {
  // This is the exact preview shape the trusted prepared-action enqueue stores
  // (`prepared-action-follow-ups.ts` canonicalizes toolName to "order.create"
  // with namespace "lighter" before `enqueueApprovalIntent` persists it).
  if (previewJson.toolName !== "order.create" || previewJson.namespace !== "lighter") {
    return false;
  }
  const criticalArgs = readRecord(previewJson.criticalArgs);
  if (criticalArgs === null) return false;
  const actualKeys = Object.keys(criticalArgs).sort().join(",");
  const feeArgs = lighterOrderFeeCriticalArgs(intent.integratorFees);
  const currentKeys = [...CRITICAL_ARG_KEYS, ...Object.keys(feeArgs)].sort().join(",");
  const legacyKeys = [...LEGACY_CRITICAL_ARG_KEYS].sort().join(",");
  const legacyNonProtective = intent.integratorFees == null && intent.triggerPriceInteger === null && actualKeys === legacyKeys;
  if (actualKeys !== currentKeys && !legacyNonProtective) {
    return false;
  }

  return (
    Object.entries(feeArgs).every(([key, value]) => criticalArgs[key] === value)
    && criticalArgs.toolId === "lighter.order.create"
    && criticalArgs.intentId === intent.intentId
    && criticalArgs.environment === intent.environment
    && criticalArgs.accountIndex === intent.accountIndex
    && criticalArgs.apiKeyIndex === intent.apiKeyIndex
    && criticalArgs.marketIndex === intent.marketIndex
    && marketTypeMatchesIndex(criticalArgs.marketType, intent.marketIndex)
    && criticalArgs.side === intent.side
    && criticalArgs.baseAmountInteger === intent.baseAmountInteger
    && criticalArgs.priceInteger === intent.priceInteger
    && (legacyNonProtective || criticalArgs.triggerPriceInteger === intent.triggerPriceInteger)
    && criticalArgs.orderType === intent.orderType
    && criticalArgs.timeInForce === intent.timeInForce
    && criticalArgs.reduceOnly === intent.reduceOnly
    && criticalArgs.previewId === intent.previewId
    && criticalArgs.matchHash === intent.matchHash
    && criticalArgs.orderExpiryIso === new Date(intent.orderExpiryMs).toISOString()
    && isNonEmptyString(criticalArgs.orderSummary)
    && isNonEmptyString(criticalArgs.marketSymbol)
    && isNonEmptyString(criticalArgs.baseAmountDisplay)
    && isNonEmptyString(criticalArgs.priceDisplay)
    && (legacyNonProtective || (intent.triggerPriceInteger === null
      ? criticalArgs.triggerPriceDisplay === null
      : isNonEmptyString(criticalArgs.triggerPriceDisplay))
    )
    && isNonEmptyString(criticalArgs.notionalDisplay)
  );
}

function marketTypeMatchesIndex(value: unknown, marketIndex: number): boolean {
  return value === "perp"
    ? marketIndex >= 0 && marketIndex <= 254
    : value === "spot" && marketIndex >= 2_048 && marketIndex <= 4_094;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function refusal(): VexError {
  return new VexError(
    ErrorCodes.LIGHTER_INVALID_REQUEST,
    REFUSAL,
    "Open the matching approval card for this prepared order, or prepare the order again.",
  );
}
