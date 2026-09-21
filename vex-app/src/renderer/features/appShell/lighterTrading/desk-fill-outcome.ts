/**
 * Provider evidence for an approved desk order. The approval transport saying
 * `succeeded` only means the tool completed; this module reads the provider's
 * exact order state and identities before the ticket describes a fill.
 */

import type {
  LighterTradingEnvironment,
  LighterTradingFill,
} from "@shared/schemas/lighter-trading.js";
import { addUnsignedDecimals, isPositiveDecimal, isUnsignedDecimal } from "./decimal.js";
import { formatDecimalString } from "./format.js";

export type DeskProviderOrderState =
  | "open"
  | "partially_filled"
  | "filled"
  | "canceled"
  | "rejected"
  | "sequencer_pending"
  | "ambiguous";

export interface DeskOrderExecution {
  readonly status: "provider_confirmed" | "sequencer_pending" | "ambiguous";
  readonly state: DeskProviderOrderState;
  readonly source: "active_order" | "inactive_order" | "account_trade" | "not_found" | null;
  readonly orderId: string | null;
  readonly tradeId: string | null;
  readonly filledBaseAmount: string | null;
  readonly averageExecutionPrice: string | null;
  /** One observed trade, not necessarily the order's full filled amount. */
  readonly observedTradeSize: string | null;
  readonly observedTradePrice: string | null;
}

export interface AwaitedFill {
  readonly marketId: number;
  readonly tradeId: string;
  /** Text that follows the fill sentence, such as the protection note. */
  readonly suffix: string;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function boundedString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= 128 ? trimmed : null;
}

function decimal(value: unknown): string | null {
  return typeof value === "string" && value.length <= 96 && isUnsignedDecimal(value)
    ? value
    : null;
}

const CONFIRMED_STATES: ReadonlySet<string> = new Set([
  "open",
  "partially_filled",
  "filled",
  "canceled",
  "rejected",
]);

/** Parse only evidence that belongs to the approved environment and market. */
export function parseDeskOrderExecution(
  toolOutput: string | undefined,
  environment: LighterTradingEnvironment,
  marketId: number,
): DeskOrderExecution | null {
  if (toolOutput === undefined) return null;
  try {
    const output = record(JSON.parse(toolOutput));
    if (output === null || output["environment"] !== environment) return null;
    const status = output["status"];
    const state = output["executionState"];
    if (status === "ambiguous" && state === "ambiguous") {
      return {
        status,
        state,
        source: null,
        orderId: null,
        tradeId: null,
        filledBaseAmount: null,
        averageExecutionPrice: null,
        observedTradeSize: null,
        observedTradePrice: null,
      };
    }
    if (status === "sequencer_pending" && state === "sequencer_pending") {
      const source = output["evidenceSource"];
      if (source !== "not_found" && source !== "inactive_order") return null;
      return {
        status,
        state,
        source,
        orderId: boundedString(output["providerOrderId"]),
        tradeId: null,
        filledBaseAmount: null,
        averageExecutionPrice: null,
        observedTradeSize: null,
        observedTradePrice: null,
      };
    }
    if (status !== "provider_confirmed" || typeof state !== "string" || !CONFIRMED_STATES.has(state)) {
      return null;
    }
    const source = output["evidenceSource"];
    if (source !== "active_order" && source !== "inactive_order" && source !== "account_trade") return null;
    const evidence = record(output["providerEvidence"]);
    if (evidence === null || evidence["source"] !== source || evidence["marketIndex"] !== marketId) return null;
    const outerOrderId = boundedString(output["providerOrderId"]);
    const evidenceOrderId = boundedString(evidence["orderId"]);
    if (outerOrderId !== null && evidenceOrderId !== null && outerOrderId !== evidenceOrderId) return null;
    const orderId = evidenceOrderId ?? outerOrderId;
    if (orderId === null) return null;
    return {
      status,
      state: state as Exclude<DeskProviderOrderState, "sequencer_pending" | "ambiguous">,
      source,
      orderId,
      tradeId: source === "account_trade" ? boundedString(evidence["tradeId"]) : null,
      filledBaseAmount: source === "account_trade" ? null : decimal(evidence["filledBaseAmount"]),
      averageExecutionPrice: source === "account_trade" ? null : decimal(evidence["averageExecutionPrice"]),
      observedTradeSize: source === "account_trade" ? decimal(evidence["size"]) : null,
      observedTradePrice: source === "account_trade" ? decimal(evidence["price"]) : null,
    };
  } catch {
    return null;
  }
}

/** Extract the trade identity that main matched by client order id or tx hash. */
export function executionTradeId(
  toolOutput: string | undefined,
  environment: LighterTradingEnvironment,
  marketId: number,
): string | null {
  return parseDeskOrderExecution(toolOutput, environment, marketId)?.tradeId ?? null;
}

/** The exact account fill proven by the approved execution result. */
export function fillByTradeId(
  fills: readonly LighterTradingFill[],
  awaited: AwaitedFill,
): LighterTradingFill | null {
  return fills.find((fill) => (
    fill.marketId === awaited.marketId && fill.tradeId === awaited.tradeId
  )) ?? null;
}

/** Every fill for one exact provider order, never another order on the market. */
export function fillsForOrder(
  fills: readonly LighterTradingFill[],
  marketId: number,
  orderId: string,
): readonly LighterTradingFill[] {
  return fills.filter((fill) => fill.marketId === marketId && fill.orderId === orderId);
}

export function totalFillSize(fills: readonly LighterTradingFill[]): string | null {
  const total = fills.reduce((sum, fill) => addUnsignedDecimals(sum, fill.size), "0");
  return isPositiveDecimal(total) ? total : null;
}

export function filledAmountSentence(size: string, symbol: string | null, averagePrice: string | null): string {
  const amount = `${formatDecimalString(size)}${symbol === null ? "" : ` ${symbol}`}`;
  return averagePrice === null
    ? `Filled ${amount}.`
    : `Filled ${amount} at ${formatDecimalString(averagePrice)}.`;
}

export function fillSentence(fill: LighterTradingFill): string {
  return filledAmountSentence(fill.size, fill.symbol, fill.price);
}
