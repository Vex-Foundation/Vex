import type { LighterAccountOrder, LighterTrade } from "@tools/lighter/types.js";

/**
 * Provider-evidence matching and state classification shared by the live
 * create path and the repair path. Both must classify identically: an outcome
 * repaired after a crash may not disagree with one observed in-line.
 */
export interface LighterOrderEvidenceScope {
  readonly accountIndex: number;
  readonly marketIndex: number;
  readonly side: "buy" | "sell";
}

export function findMatchingLighterOrder(
  orders: readonly LighterAccountOrder[],
  scope: LighterOrderEvidenceScope,
  clientOrderIndex: string,
): LighterAccountOrder | null {
  return orders.find((order) =>
    order.owner_account_index === scope.accountIndex
    && order.market_index === scope.marketIndex
    && order.client_order_id === clientOrderIndex
  ) ?? null;
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
    status: order.status ?? null,
    remainingBaseAmount: order.remaining_base_amount ?? null,
    filledBaseAmount: order.filled_base_amount ?? null,
    filledQuoteAmount: order.filled_quote_amount ?? null,
  };
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
