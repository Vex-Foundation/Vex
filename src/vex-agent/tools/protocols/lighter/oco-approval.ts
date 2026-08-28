import { formatLighterIntegerAmount } from "@tools/lighter/order-preview.js";
import * as approvalIntentsRepo from "@vex-agent/db/repos/approval-intents.js";
import * as approvalsRepo from "@vex-agent/db/repos/approvals.js";
import type { LighterOcoExecutionIntentRow } from "@vex-agent/db/repos/lighter-oco-execution-intents.js";
import type { LighterOrderPreviewRow } from "@vex-agent/db/repos/lighter-order-previews.js";
import { ErrorCodes, VexError } from "../../../../errors.js";

export interface LighterOcoApprovalDisclosure {
  readonly marketSymbol: string;
  readonly marketType: "perp";
  readonly baseAmountDisplay: string;
  readonly stopLossTriggerDisplay: string;
  readonly stopLossBoundDisplay: string;
  readonly takeProfitTriggerDisplay: string;
  readonly takeProfitBoundDisplay: string;
  readonly orderExpiryIso: string;
  readonly orderSummary: string;
}

export function buildLighterOcoApprovalDisclosure(
  intent: LighterOcoExecutionIntentRow,
  stopLoss: LighterOrderPreviewRow,
  takeProfit: LighterOrderPreviewRow,
): LighterOcoApprovalDisclosure {
  assertLeg(intent, stopLoss, "stop-loss");
  assertLeg(intent, takeProfit, "take-profit");
  const stopStored = displayContext(stopLoss.previewJson);
  const takeStored = displayContext(takeProfit.previewJson);
  if (
    stopStored.symbol !== takeStored.symbol
    || stopStored.baseDecimals !== takeStored.baseDecimals
    || stopStored.priceDecimals !== takeStored.priceDecimals
  ) {
    throw refusal("The OCO child previews disagree on market display identity.");
  }
  const display = (value: string, decimals: number) =>
    formatLighterIntegerAmount(parseInteger(value), decimals);
  const baseAmountDisplay = display(intent.baseAmountInteger, stopStored.baseDecimals);
  const stopLossTriggerDisplay = display(intent.stopLossTriggerPriceInteger, stopStored.priceDecimals);
  const stopLossBoundDisplay = display(intent.stopLossPriceInteger, stopStored.priceDecimals);
  const takeProfitTriggerDisplay = display(intent.takeProfitTriggerPriceInteger, stopStored.priceDecimals);
  const takeProfitBoundDisplay = display(intent.takeProfitPriceInteger, stopStored.priceDecimals);
  const orderExpiryIso = new Date(intent.orderExpiryMs).toISOString();
  const environment = intent.environment === "core" ? "Lighter Core" : "Robinhood Chain Lighter";
  return {
    marketSymbol: stopStored.symbol,
    marketType: "perp",
    baseAmountDisplay,
    stopLossTriggerDisplay,
    stopLossBoundDisplay,
    takeProfitTriggerDisplay,
    takeProfitBoundDisplay,
    orderExpiryIso,
    orderSummary:
      `Protect ${baseAmountDisplay} ${stopStored.symbol} with one native Lighter OCO group: `
      + `reduce-only stop-loss trigger ${stopLossTriggerDisplay} with execution bound ${stopLossBoundDisplay}, `
      + `and reduce-only take-profit trigger ${takeProfitTriggerDisplay} with execution bound ${takeProfitBoundDisplay}; `
      + `${intent.side}; expires ${orderExpiryIso}; ${environment}. When either child executes, Lighter cancels the sibling. `
      + "API acceptance is not final protection; both child orders must be verified from account evidence.",
  };
}

export async function assertLighterOcoApprovalBinding(input: {
  readonly approvalId: string;
  readonly sessionId: string;
  readonly intent: LighterOcoExecutionIntentRow;
  readonly stopLossPreview: LighterOrderPreviewRow;
  readonly takeProfitPreview: LighterOrderPreviewRow;
}): Promise<void> {
  const approval = await approvalsRepo.getByIdForSession(input.approvalId, input.sessionId);
  if (
    approval === null
    || approval.status !== "approved"
    || !toolCallTargetsIntent(approval.toolCall, input.intent.intentId)
  ) throw refusal("The approval queue entry does not target this OCO intent.");
  const audit = await approvalIntentsRepo.getByApprovalId(input.approvalId);
  if (
    audit === null
    || audit.sessionId !== input.sessionId
    || audit.decision !== "approved"
    || audit.actionKind !== "external_post"
    || audit.executionStatus !== "dispatching"
    || !previewMatches(
      audit.previewJson,
      input.intent,
      buildLighterOcoApprovalDisclosure(
        input.intent,
        input.stopLossPreview,
        input.takeProfitPreview,
      ),
    )
  ) throw refusal("The approved disclosure does not exactly match this OCO intent.");
}

export function lighterOcoCriticalArgs(
  intent: LighterOcoExecutionIntentRow,
  disclosure: LighterOcoApprovalDisclosure,
): Record<string, string | number | boolean | null> {
  return {
    orderSummary: disclosure.orderSummary,
    marketSymbol: disclosure.marketSymbol,
    marketType: disclosure.marketType,
    baseAmountDisplay: disclosure.baseAmountDisplay,
    stopLossTriggerDisplay: disclosure.stopLossTriggerDisplay,
    stopLossBoundDisplay: disclosure.stopLossBoundDisplay,
    takeProfitTriggerDisplay: disclosure.takeProfitTriggerDisplay,
    takeProfitBoundDisplay: disclosure.takeProfitBoundDisplay,
    orderExpiryIso: disclosure.orderExpiryIso,
    toolId: "lighter.order.create",
    intentId: intent.intentId,
    environment: intent.environment,
    accountIndex: intent.accountIndex,
    apiKeyIndex: intent.apiKeyIndex,
    marketIndex: intent.marketIndex,
    side: intent.side,
    baseAmountInteger: intent.baseAmountInteger,
    stopLossPreviewId: intent.stopLossPreviewId,
    stopLossPriceInteger: intent.stopLossPriceInteger,
    stopLossTriggerPriceInteger: intent.stopLossTriggerPriceInteger,
    takeProfitPreviewId: intent.takeProfitPreviewId,
    takeProfitPriceInteger: intent.takeProfitPriceInteger,
    takeProfitTriggerPriceInteger: intent.takeProfitTriggerPriceInteger,
    matchHash: intent.matchHash,
    groupingType: "one-cancels-the-other",
    reduceOnly: true,
  };
}

function previewMatches(
  value: Record<string, unknown>,
  intent: LighterOcoExecutionIntentRow,
  disclosure: LighterOcoApprovalDisclosure,
): boolean {
  if (value.toolName !== "order.create" || value.namespace !== "lighter") return false;
  const critical = record(value.criticalArgs);
  if (critical === null) return false;
  const expected = lighterOcoCriticalArgs(intent, disclosure);
  const expectedKeys = Object.keys(expected).sort();
  if (Object.keys(critical).sort().join(",") !== expectedKeys.join(",")) return false;
  return expectedKeys.every((key) => critical[key] === expected[key]);
}

function toolCallTargetsIntent(toolCall: Record<string, unknown>, intentId: string): boolean {
  if ((toolCall.command ?? toolCall.name) !== "execute_tool") return false;
  const args = record(toolCall.args ?? toolCall.arguments);
  const params = record(args?.params);
  return args?.toolId === "lighter.order.create"
    && params !== null
    && Object.keys(params).join(",") === "intentId"
    && params.intentId === intentId;
}

function assertLeg(
  intent: LighterOcoExecutionIntentRow,
  row: LighterOrderPreviewRow,
  kind: "stop-loss" | "take-profit",
): void {
  const prefix = kind === "stop-loss" ? "stopLoss" : "takeProfit";
  if (
    row.previewId !== intent[`${prefix}PreviewId`]
    || row.matchHash !== intent[`${prefix}MatchHash`]
    || row.orderType !== kind
    || row.environment !== intent.environment
    || row.accountIndex !== intent.accountIndex
    || row.apiKeyIndex !== intent.apiKeyIndex
    || row.marketIndex !== intent.marketIndex
    || row.side !== intent.side
    || row.baseAmountInteger !== intent.baseAmountInteger
    || row.priceInteger !== intent[`${prefix}PriceInteger`]
    || row.triggerPriceInteger !== intent[`${prefix}TriggerPriceInteger`]
    || !row.reduceOnly
    || row.timeInForce !== "immediate-or-cancel"
    || row.orderExpiryMs !== intent.orderExpiryMs
  ) throw refusal(`The ${kind} preview no longer matches the OCO intent.`);
}

function displayContext(value: Record<string, unknown>): {
  readonly symbol: string; readonly baseDecimals: number; readonly priceDecimals: number;
} {
  const base = record(value.baseAmount);
  const price = record(value.price);
  if (
    typeof value.symbol !== "string" || value.symbol.length === 0
    || value.marketType !== "perp"
    || !Number.isInteger(base?.decimals) || !Number.isInteger(price?.decimals)
  ) throw refusal("The persisted OCO display evidence is incomplete.");
  return { symbol: value.symbol, baseDecimals: base!.decimals as number, priceDecimals: price!.decimals as number };
}

function parseInteger(value: string): bigint {
  if (!/^[1-9][0-9]*$/.test(value)) throw refusal("An OCO wire amount is invalid.");
  return BigInt(value);
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function refusal(reason: string): VexError {
  return new VexError(
    ErrorCodes.LIGHTER_INVALID_REQUEST,
    `${reason} No grouped order was signed or submitted.`,
    "Run a fresh Lighter OCO preview and approve that exact group.",
  );
}
