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

const MODIFY_CRITICAL_KEYS = [
  ...CRITICAL_KEYS,
  "requestedBaseAmount", "requestedBaseAmountInteger", "requestedPrice", "requestedPriceInteger",
] as const;

const CANCEL_ALL_CRITICAL_KEYS = [
  "accountIndex", "actionType", "apiKeyIndex", "cancelAtMs", "environment", "intentId",
  "matchHash", "orderCount", "orderIdentities", "summary", "timeInForce", "toolId",
] as const;

const CLOSE_POSITION_CRITICAL_KEYS = [
  "accountIndex", "actionType", "apiKeyIndex", "averageEntryPrice", "baseAmount",
  "baseAmountInteger", "closingSide", "environment", "intentId", "marketIndex", "matchHash",
  "maxSlippageBps", "orderType", "positionAmount", "positionSide", "priceInteger", "reduceOnly",
  "summary", "symbol", "timeInForce", "toolId", "worstAcceptablePrice",
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

export async function assertLighterModifyOrderApprovalBinding(input: {
  readonly approvalId: string;
  readonly sessionId: string;
  readonly intent: LighterOrderLifecycleIntentRow;
}): Promise<void> {
  const approval = await approvalsRepo.getByIdForSession(input.approvalId, input.sessionId);
  const args = record(approval?.toolCall.args ?? approval?.toolCall.arguments);
  const params = record(args?.params);
  if (
    approval?.status !== "approved" || (approval.toolCall.command ?? approval.toolCall.name) !== "execute_tool"
    || args?.toolId !== "lighter.order.modify" || Object.keys(params ?? {}).join(",") !== "intentId"
    || params?.intentId !== input.intent.intentId
  ) throw modifyRefusal();

  const audit = await approvalIntentsRepo.getByApprovalId(input.approvalId);
  const critical = record(audit?.previewJson.criticalArgs);
  const snapshot = input.intent.providerSnapshotJson;
  if (
    audit?.sessionId !== input.sessionId || audit.decision !== "approved"
    || audit.actionKind !== "external_post" || audit.executionStatus !== "dispatching"
    || audit.previewJson.toolName !== "order.modify" || audit.previewJson.namespace !== "lighter"
    || Object.keys(critical ?? {}).sort().join(",") !== [...MODIFY_CRITICAL_KEYS].sort().join(",")
    || critical?.toolId !== "lighter.order.modify" || critical.intentId !== input.intent.intentId
    || critical.actionType !== "modify" || critical.environment !== input.intent.environment
    || critical.accountIndex !== input.intent.accountIndex || critical.apiKeyIndex !== input.intent.apiKeyIndex
    || critical.marketIndex !== input.intent.marketIndex || critical.providerOrderId !== input.intent.providerOrderId
    || critical.clientOrderId !== snapshot.clientOrderId || critical.side !== snapshot.side
    || critical.orderType !== snapshot.type || critical.timeInForce !== snapshot.timeInForce
    || critical.price !== snapshot.price || critical.initialBaseAmount !== snapshot.initialBaseAmount
    || critical.remainingBaseAmount !== snapshot.remainingBaseAmount
    || critical.filledBaseAmount !== snapshot.filledBaseAmount || critical.matchHash !== input.intent.matchHash
    || critical.requestedBaseAmountInteger !== input.intent.requestedBaseAmountInteger
    || critical.requestedPriceInteger !== input.intent.requestedPriceInteger
    || typeof critical.requestedBaseAmount !== "string" || typeof critical.requestedPrice !== "string"
    || typeof critical.summary !== "string" || critical.summary.length === 0
  ) throw modifyRefusal();
}

export async function assertLighterCancelAllApprovalBinding(input: {
  readonly approvalId: string;
  readonly sessionId: string;
  readonly intent: LighterOrderLifecycleIntentRow;
}): Promise<void> {
  const approval = await approvalsRepo.getByIdForSession(input.approvalId, input.sessionId);
  const args = record(approval?.toolCall.args ?? approval?.toolCall.arguments);
  const params = record(args?.params);
  if (
    approval?.status !== "approved" || (approval.toolCall.command ?? approval.toolCall.name) !== "execute_tool"
    || args?.toolId !== "lighter.order.cancelAll" || Object.keys(params ?? {}).join(",") !== "intentId"
    || params?.intentId !== input.intent.intentId
  ) throw cancelAllRefusal();
  const audit = await approvalIntentsRepo.getByApprovalId(input.approvalId);
  const critical = record(audit?.previewJson.criticalArgs);
  const orders = Array.isArray(input.intent.providerSnapshotJson.orders)
    ? input.intent.providerSnapshotJson.orders as Record<string, unknown>[] : [];
  const identities = orders.map((order) => `${order.marketIndex}:${order.orderId}`).join(",");
  if (
    audit?.sessionId !== input.sessionId || audit.decision !== "approved"
    || audit.actionKind !== "external_post" || audit.executionStatus !== "dispatching"
    || audit.previewJson.toolName !== "order.cancelAll" || audit.previewJson.namespace !== "lighter"
    || Object.keys(critical ?? {}).sort().join(",") !== [...CANCEL_ALL_CRITICAL_KEYS].sort().join(",")
    || critical?.toolId !== "lighter.order.cancelAll" || critical.intentId !== input.intent.intentId
    || critical.actionType !== "cancel_all" || critical.environment !== input.intent.environment
    || critical.accountIndex !== input.intent.accountIndex || critical.apiKeyIndex !== input.intent.apiKeyIndex
    || critical.orderCount !== orders.length || critical.orderIdentities !== identities
    || critical.matchHash !== input.intent.matchHash || critical.timeInForce !== 0 || critical.cancelAtMs !== "0"
    || typeof critical.summary !== "string" || critical.summary.length === 0
  ) throw cancelAllRefusal();
}

export async function assertLighterClosePositionApprovalBinding(input: {
  readonly approvalId: string;
  readonly sessionId: string;
  readonly intent: LighterOrderLifecycleIntentRow;
}): Promise<void> {
  const approval = await approvalsRepo.getByIdForSession(input.approvalId, input.sessionId);
  const args = record(approval?.toolCall.args ?? approval?.toolCall.arguments);
  const params = record(args?.params);
  if (
    approval?.status !== "approved" || (approval.toolCall.command ?? approval.toolCall.name) !== "execute_tool"
    || args?.toolId !== "lighter.position.close" || Object.keys(params ?? {}).join(",") !== "intentId"
    || params?.intentId !== input.intent.intentId
  ) throw closeRefusal();
  const audit = await approvalIntentsRepo.getByApprovalId(input.approvalId);
  const critical = record(audit?.previewJson.criticalArgs);
  const position = record(input.intent.providerSnapshotJson.position);
  if (
    audit?.sessionId !== input.sessionId || audit.decision !== "approved"
    || audit.actionKind !== "external_post" || audit.executionStatus !== "dispatching"
    || audit.previewJson.toolName !== "position.close" || audit.previewJson.namespace !== "lighter"
    || Object.keys(critical ?? {}).sort().join(",") !== [...CLOSE_POSITION_CRITICAL_KEYS].sort().join(",")
    || critical?.toolId !== "lighter.position.close" || critical.intentId !== input.intent.intentId
    || critical.actionType !== "close_position" || critical.environment !== input.intent.environment
    || critical.accountIndex !== input.intent.accountIndex || critical.apiKeyIndex !== input.intent.apiKeyIndex
    || critical.marketIndex !== input.intent.marketIndex || critical.symbol !== position?.symbol
    || critical.positionSide !== position?.side || critical.positionAmount !== position?.position
    || critical.averageEntryPrice !== position?.averageEntryPrice || critical.closingSide !== input.intent.requestedSide
    || critical.baseAmountInteger !== input.intent.requestedBaseAmountInteger
    || critical.priceInteger !== input.intent.requestedPriceInteger
    || critical.maxSlippageBps !== input.intent.providerSnapshotJson.maxSlippageBps
    || critical.reduceOnly !== true || critical.orderType !== "market" || critical.timeInForce !== "immediate-or-cancel"
    || critical.matchHash !== input.intent.matchHash
    || typeof critical.baseAmount !== "string" || typeof critical.worstAcceptablePrice !== "string"
    || typeof critical.summary !== "string" || critical.summary.length === 0
  ) throw closeRefusal();
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

function modifyRefusal(): VexError {
  return new VexError(
    ErrorCodes.LIGHTER_INVALID_REQUEST,
    "Approved Lighter modification refused because the approval does not match the exact provider order and replacement values.",
    "Open the matching modification approval card or prepare a fresh modification.",
  );
}

function cancelAllRefusal(): VexError {
  return new VexError(
    ErrorCodes.LIGHTER_INVALID_REQUEST,
    "Approved Lighter cancel-all refused because the approval does not match the exact account-wide active-order set.",
    "Open the matching cancel-all approval card or prepare a fresh account-wide cancellation.",
  );
}

function closeRefusal(): VexError {
  return new VexError(
    ErrorCodes.LIGHTER_INVALID_REQUEST,
    "Approved Lighter position close refused because the approval does not match the exact live position, side, size, and slippage-bounded reduce-only order.",
    "Open the matching close-position approval card or prepare a fresh close from current position and book state.",
  );
}
