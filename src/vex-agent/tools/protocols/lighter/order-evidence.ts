import type { LighterAccountOrder, LighterTrade } from "@tools/lighter/types.js";
import type {
  LighterOrderTimeInForce,
  LighterOrderType,
} from "@tools/lighter/order-preview.js";
import {
  decimalToLighterInteger,
} from "@tools/lighter/order-preview.js";

/**
 * Provider-evidence matching and state classification shared by the live
 * create path and the repair path. Both must classify identically: an outcome
 * repaired after a crash may not disagree with one observed in-line.
 */
export interface LighterOrderEvidenceScope {
  readonly accountIndex: number;
  readonly marketIndex: number;
  readonly side: "buy" | "sell";
  readonly orderType?: LighterOrderType;
  readonly timeInForce?: LighterOrderTimeInForce;
  readonly reduceOnly?: boolean;
  readonly baseAmountInteger?: string;
  readonly priceInteger?: string;
  readonly triggerPriceInteger?: string | null;
  readonly baseDecimals?: number;
  readonly priceDecimals?: number;
  /** The actual signer-wire expiry, which is zero for ordinary IOC orders. */
  readonly signedOrderExpiryMs?: number;
  /** Set only by buildLighterOrderEvidenceScope after complete validation. */
  readonly exactSemanticTerms?: true;
}

export interface BuildLighterOrderEvidenceScopeInput {
  readonly approved: {
    readonly accountIndex: number;
    readonly marketIndex: number;
    readonly side: "buy" | "sell";
    readonly orderType: LighterOrderType;
    readonly timeInForce: LighterOrderTimeInForce;
    readonly reduceOnly: boolean;
    readonly baseAmountInteger: string;
    readonly priceInteger: string;
    readonly triggerPriceInteger: string | null;
  };
  readonly baseDecimals: number;
  readonly priceDecimals: number;
  readonly signedOrderExpiryMs: number;
}

export class LighterOrderEvidenceConflictError extends Error {
  override readonly name = "LighterOrderEvidenceConflictError";
}

/**
 * Builds the complete canonical semantic scope needed to treat an account
 * order as positive provider evidence. Callers must use the actual signer-wire
 * expiry, not the locally approval-bound timestamp used by ordinary IOC plans.
 */
export function buildLighterOrderEvidenceScope(
  input: BuildLighterOrderEvidenceScopeInput,
): LighterOrderEvidenceScope {
  const { approved } = input;
  assertCanonicalInteger(approved.baseAmountInteger, false, "base amount");
  assertCanonicalInteger(approved.priceInteger, false, "price");
  if (approved.triggerPriceInteger !== null) {
    assertCanonicalInteger(approved.triggerPriceInteger, false, "trigger price");
  }
  if (!isDecimals(input.baseDecimals) || !isDecimals(input.priceDecimals)) {
    throw new Error("Lighter order evidence scope has invalid stored decimal precision.");
  }
  if (!Number.isSafeInteger(input.signedOrderExpiryMs) || input.signedOrderExpiryMs < 0) {
    throw new Error("Lighter order evidence scope has an invalid signed expiry.");
  }
  return {
    accountIndex: approved.accountIndex,
    marketIndex: approved.marketIndex,
    side: approved.side,
    orderType: approved.orderType,
    timeInForce: approved.timeInForce,
    reduceOnly: approved.reduceOnly,
    baseAmountInteger: approved.baseAmountInteger,
    priceInteger: approved.priceInteger,
    triggerPriceInteger: approved.triggerPriceInteger,
    baseDecimals: input.baseDecimals,
    priceDecimals: input.priceDecimals,
    signedOrderExpiryMs: input.signedOrderExpiryMs,
    exactSemanticTerms: true,
  };
}

export function findMatchingLighterOrder(
  orders: readonly LighterAccountOrder[],
  scope: LighterOrderEvidenceScope,
  clientOrderIndex: string,
): LighterAccountOrder | null {
  const identityMatches = orders.filter((order) =>
    order.owner_account_index === scope.accountIndex
    && order.market_index === scope.marketIndex
    && order.client_order_id === clientOrderIndex
  );
  if (identityMatches.length > 1) {
    throw new LighterOrderEvidenceConflictError(
      "Lighter returned duplicate order evidence for one client order id.",
    );
  }
  const match = identityMatches[0] ?? null;
  if (match !== null && !lighterOrderMatchesEvidenceScope(match, scope)) {
    throw new LighterOrderEvidenceConflictError(
      "Lighter order evidence conflicts with the approved order semantics.",
    );
  }
  return match;
}

/**
 * Reject provider fields that contradict the approved order while tolerating
 * older account endpoints that omit optional semantic fields entirely. The
 * client-order id still supplies the primary signed identity; this guard makes
 * every provider-supplied semantic fact fail closed when it disagrees. The
 * account endpoint always supplies decimal price and initial size, so callers
 * without the stored precision needed to compare those values cannot confirm
 * the order.
 */
export function lighterOrderMatchesEvidenceScope(
  order: LighterAccountOrder,
  scope: LighterOrderEvidenceScope,
): boolean {
  if (order.side !== undefined) {
    const side = order.side.trim().toLowerCase();
    // Lighter still returns an empty deprecated `side` field in some account
    // payloads. Treat only the blank value as omitted; `is_ask` below remains
    // authoritative when present, while every non-empty unknown/conflicting
    // value still fails closed.
    if (side !== "" && ((side !== "buy" && side !== "sell") || side !== scope.side)) return false;
  }
  if (order.is_ask !== undefined && order.is_ask !== (scope.side === "sell")) return false;
  if (
    scope.orderType !== undefined
    && order.type !== undefined
    && normalizeProviderOrderLabel(order.type) !== scope.orderType
  ) return false;
  if (
    scope.timeInForce !== undefined
    && order.time_in_force !== undefined
    && normalizeProviderOrderLabel(order.time_in_force) !== scope.timeInForce
  ) return false;
  if (
    scope.reduceOnly !== undefined
    && order.reduce_only !== undefined
    && order.reduce_only !== scope.reduceOnly
  ) return false;
  if (scope.exactSemanticTerms === true) {
    if (!providerDecimalMatchesApprovedInteger(
      order.initial_base_amount,
      scope.baseDecimals,
      scope.baseAmountInteger,
      false,
    )) return false;
    if (!providerDecimalMatchesApprovedInteger(
      order.price,
      scope.priceDecimals,
      scope.priceInteger,
      false,
    )) return false;
    if (order.base_size !== undefined && !providerWireIntegerMatches(order.base_size, scope.baseAmountInteger)) {
      return false;
    }
    if (order.base_price !== undefined && !providerWireIntegerMatches(order.base_price, scope.priceInteger)) {
      return false;
    }
    if (
      order.trigger_price !== undefined
      && !providerDecimalMatchesApprovedInteger(
        order.trigger_price,
        scope.priceDecimals,
        scope.triggerPriceInteger === null ? "0" : scope.triggerPriceInteger,
        true,
      )
    ) return false;
    if (
      order.order_expiry !== undefined
      && (
        scope.signedOrderExpiryMs === undefined
        || !Number.isSafeInteger(order.order_expiry)
        || order.order_expiry !== scope.signedOrderExpiryMs
      )
    ) return false;
  }
  return true;
}

function providerDecimalMatchesApprovedInteger(
  providerValue: string,
  decimals: number | undefined,
  approvedInteger: string | null | undefined,
  allowZero: boolean,
): boolean {
  if (!isDecimals(decimals) || approvedInteger === undefined || approvedInteger === null) return false;
  try {
    assertCanonicalInteger(approvedInteger, allowZero, "approved provider evidence value");
    return decimalToLighterInteger(
      providerValue,
      decimals,
      "provider order evidence value",
      { allowZero },
    ).toString() === approvedInteger;
  } catch {
    return false;
  }
}

function providerWireIntegerMatches(
  providerValue: number,
  approvedInteger: string | undefined,
): boolean {
  if (
    approvedInteger === undefined
    || !Number.isSafeInteger(providerValue)
    || providerValue < 0
  ) return false;
  try {
    assertCanonicalInteger(approvedInteger, true, "approved provider evidence value");
    return BigInt(providerValue) === BigInt(approvedInteger);
  } catch {
    return false;
  }
}

function assertCanonicalInteger(value: string, allowZero: boolean, field: string): void {
  const pattern = allowZero ? /^(?:0|[1-9][0-9]*)$/ : /^[1-9][0-9]*$/;
  if (!pattern.test(value)) throw new Error(`Lighter order evidence ${field} is not canonical.`);
}

function isDecimals(value: number | undefined): value is number {
  return value !== undefined && Number.isInteger(value) && value >= 0 && value <= 18;
}

export function findMatchingLighterTrade(
  trades: readonly LighterTrade[],
  scope: LighterOrderEvidenceScope,
  clientOrderIndex: string,
  submittedTxHash: string,
): LighterTrade | null {
  return trades.find((trade) => {
    if (trade.market_id !== scope.marketIndex) return false;
    if (trade.tx_hash === submittedTxHash) return true;
    if (scope.side === "buy") {
      return trade.bid_account_id === scope.accountIndex && trade.bid_client_id_str === clientOrderIndex;
    }
    return trade.ask_account_id === scope.accountIndex && trade.ask_client_id_str === clientOrderIndex;
  }) ?? null;
}

export function stateFromActiveLighterOrder(
  order: LighterAccountOrder,
): "open" | "partially_filled" {
  return lighterDecimalGreaterThanZero(order.filled_base_amount) ? "partially_filled" : "open";
}

export function stateFromInactiveLighterOrder(
  order: LighterAccountOrder,
): "sequencer_pending" | "partially_filled" | "filled" | "canceled" | "rejected" {
  const status = (order.status ?? "").toLowerCase();
  const hasPositiveFill = lighterDecimalGreaterThanZero(order.filled_base_amount);
  if (status.includes("partial") && status.includes("fill")) return "partially_filled";
  if (status.includes("fill")) return "filled";
  if (status.includes("cancel") || status.includes("expire")) {
    return hasPositiveFill ? "partially_filled" : "canceled";
  }
  if (status.includes("reject") || status.includes("fail")) return "rejected";
  if (hasPositiveFill) return "partially_filled";
  return "sequencer_pending";
}

export function lighterDecimalGreaterThanZero(value: string | undefined): boolean {
  if (value === undefined || !/^\d+(?:\.\d+)?$/.test(value)) return false;
  return /[1-9]/.test(value);
}

export function lighterOrderEvidenceJson(
  source: "active_order" | "inactive_order",
  order: LighterAccountOrder,
  clientOrderIndex: string,
): Record<string, unknown> {
  return {
    source,
    clientOrderIndex,
    orderId: order.order_id,
    marketIndex: order.market_index,
    ownerAccountIndex: order.owner_account_index,
    side: providerOrderSide(order),
    orderType: order.type ?? null,
    timeInForce: order.time_in_force ?? null,
    reduceOnly: order.reduce_only ?? null,
    triggerPrice: order.trigger_price ?? null,
    initialBaseAmount: order.initial_base_amount,
    price: order.price,
    orderExpiry: order.order_expiry ?? null,
    status: order.status ?? null,
    remainingBaseAmount: order.remaining_base_amount ?? null,
    filledBaseAmount: order.filled_base_amount ?? null,
    filledQuoteAmount: order.filled_quote_amount ?? null,
  };
}

function providerOrderSide(order: LighterAccountOrder): "buy" | "sell" | null {
  const side = order.side?.trim().toLowerCase();
  if (side === "buy" || side === "sell") return side;
  if (order.is_ask === true) return "sell";
  if (order.is_ask === false) return "buy";
  return null;
}

function normalizeProviderOrderLabel(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_]+/g, "-");
}

export function lighterTradeEvidenceJson(
  trade: LighterTrade,
  scope: LighterOrderEvidenceScope,
  clientOrderIndex: string,
): Record<string, unknown> {
  return {
    source: "account_trade",
    clientOrderIndex,
    tradeId: trade.trade_id_str,
    orderId: lighterOrderIdFromTrade(trade, scope),
    marketIndex: trade.market_id,
    size: trade.size,
    price: trade.price,
    accountSide: scope.side,
  };
}

export function lighterOrderIdFromTrade(
  trade: LighterTrade,
  scope: LighterOrderEvidenceScope,
): string {
  return scope.side === "buy" ? trade.bid_id_str : trade.ask_id_str;
}
