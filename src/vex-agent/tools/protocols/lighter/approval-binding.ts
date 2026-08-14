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
  "matchHash",
  "notionalDisplay",
  "orderExpiryIso",
  "orderSummary",
  "orderType",
  "previewId",
  "priceDisplay",
  "priceInteger",
  "reduceOnly",
  "side",
  "timeInForce",
  "toolId",
] as const;

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
  if (Object.keys(criticalArgs).sort().join(",") !== [...CRITICAL_ARG_KEYS].sort().join(",")) {
    return false;
  }

  return (
    criticalArgs.toolId === "lighter.order.create"
    && criticalArgs.intentId === intent.intentId
    && criticalArgs.environment === intent.environment
    && criticalArgs.accountIndex === intent.accountIndex
    && criticalArgs.apiKeyIndex === intent.apiKeyIndex
    && criticalArgs.marketIndex === intent.marketIndex
    && criticalArgs.side === intent.side
    && criticalArgs.baseAmountInteger === intent.baseAmountInteger
    && criticalArgs.priceInteger === intent.priceInteger
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
    && isNonEmptyString(criticalArgs.notionalDisplay)
  );
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
