/**
 * Human rows for a Lighter order card.
 *
 * `criticalArgs` is the signer's field list, and a person reading "Buy 0.0002
 * BTC at worst 77199.7" should not have to find it between INTEGRATORMAKERFEE
 * and MATCHHASH. This turns the order-shaped cards (create, OCO protect,
 * close, cancel, modify, cancel-all) into a handful of labeled facts. Display
 * only: the card still binds and shows the full field list, folded under
 * these rows.
 *
 * Tolerant reader: a row whose fact is absent is skipped, never invented, and
 * an unknown tool yields `null` so the card falls back to the raw list.
 */

import type { ApprovalPreview } from "@shared/schemas/approvals.js";
import { LIGHTER_ENVIRONMENT_NAMES } from "@shared/lighter-environment-labels.js";

export interface LighterOrderFact {
  readonly label: string;
  readonly value: string;
}

type Args = ApprovalPreview["criticalArgs"];

const ORDER_TYPE_LABELS: Readonly<Record<string, string>> = {
  market: "Market",
  limit: "Limit",
  "stop-loss": "Stop-loss",
  "stop-loss-limit": "Stop-loss limit",
  "take-profit": "Take-profit",
  "take-profit-limit": "Take-profit limit",
};

const TIME_IN_FORCE_LABELS: Readonly<Record<string, string>> = {
  "good-till-time": "GTC",
  "immediate-or-cancel": "IOC",
  "post-only": "Post-only",
};

function text(value: unknown): string | null {
  if (typeof value === "string") return value.trim().length > 0 ? value : null;
  if (typeof value === "number") return String(value);
  return null;
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function lookup(table: Readonly<Record<string, string>>, value: unknown): string | null {
  const key = text(value);
  return key === null ? null : table[key] ?? key;
}

function push(rows: LighterOrderFact[], label: string, value: string | null): void {
  if (value !== null) rows.push({ label, value });
}

function joinParts(parts: readonly (string | null)[], separator: string): string | null {
  const kept = parts.filter((part): part is string => part !== null);
  return kept.length === 0 ? null : kept.join(separator);
}

function marketRow(symbol: string | null, marketType: unknown, environment: unknown): string | null {
  return joinParts([joinParts([symbol, text(marketType)], " "), lookup(LIGHTER_ENVIRONMENT_NAMES, environment)], " · ");
}

function orderRow(args: Args): string | null {
  const behavior = joinParts([lookup(ORDER_TYPE_LABELS, args.orderType), lookup(TIME_IN_FORCE_LABELS, args.timeInForce)], " ");
  return joinParts([behavior, args.reduceOnly === true ? "Reduce-only" : null], " · ");
}

/**
 * The notional is a product of two signed integers, so it carries every
 * decimal of both; the row rounds it to cents and the exact string stays in
 * the folded signed fields.
 */
function roundedQuote(value: string | null): string | null {
  if (value === null) return null;
  const amount = Number(value);
  return Number.isFinite(amount) ? `≈ ${amount.toFixed(2)}` : value;
}

function createRows(args: Args): LighterOrderFact[] {
  const rows: LighterOrderFact[] = [];
  const side = text(args.side);
  const symbol = text(args.marketSymbol);
  push(rows, "Action", joinParts([side === null ? null : capitalize(side), text(args.baseAmountDisplay), symbol], " "));
  push(rows, "Market", marketRow(symbol, args.marketType, args.environment));
  push(rows, "Order", orderRow(args));
  push(rows, "Trigger", text(args.triggerPriceDisplay));
  const price = text(args.priceDisplay);
  push(rows, "Price", args.orderType === "market" && price !== null ? `Worst ${price}` : price);
  push(rows, "Notional", roundedQuote(text(args.notionalDisplay)));
  // An IOC order's timestamp is a stored reference, not a signed expiry; the
  // folded field list keeps its full label.
  if (args.timeInForce === "good-till-time") push(rows, "Expires", text(args.orderExpiryIso));
  return rows;
}

function legRow(trigger: unknown, bound: unknown): string | null {
  const t = text(trigger);
  const b = text(bound);
  return joinParts([t === null ? null : `${t} trigger`, b === null ? null : `${b} bound`], " · ");
}

function ocoRows(args: Args): LighterOrderFact[] {
  const rows: LighterOrderFact[] = [];
  const side = text(args.side);
  const symbol = text(args.marketSymbol);
  push(rows, "Action", joinParts([side === null ? null : capitalize(side), text(args.baseAmountDisplay), symbol, "· OCO"], " "));
  push(rows, "Market", marketRow(symbol, args.marketType, args.environment));
  push(rows, "Stop-loss", legRow(args.stopLossTriggerDisplay, args.stopLossBoundDisplay));
  push(rows, "Take-profit", legRow(args.takeProfitTriggerDisplay, args.takeProfitBoundDisplay));
  push(rows, "Order", "Reduce-only · one cancels the other");
  push(rows, "Expires", text(args.orderExpiryIso));
  return rows;
}

function closeRows(args: Args): LighterOrderFact[] {
  const rows: LighterOrderFact[] = [];
  const symbol = text(args.symbol);
  push(rows, "Action", joinParts(["Close", text(args.positionAmount), symbol, text(args.positionSide)], " "));
  push(rows, "Market", marketRow(symbol, null, args.environment));
  const closingSide = text(args.closingSide);
  push(rows, "Order", joinParts([closingSide === null ? null : capitalize(closingSide), orderRow(args)], " "));
  push(rows, "Worst price", text(args.worstAcceptablePrice));
  const slippage = typeof args.maxSlippageBps === "number" && args.maxSlippageBps >= 0 ? `${args.maxSlippageBps} bps` : null;
  push(rows, "Max slippage", slippage);
  push(rows, "Entry", text(args.averageEntryPrice));
  return rows;
}

function cancelRows(args: Args): LighterOrderFact[] {
  const rows: LighterOrderFact[] = [];
  const orderId = text(args.providerOrderId);
  push(rows, "Action", orderId === null ? "Cancel order" : `Cancel order ${orderId}`);
  const marketIndex = text(args.marketIndex);
  push(rows, "Market", marketRow(marketIndex === null ? null : `Market ${marketIndex}`, null, args.environment));
  const side = text(args.side);
  const price = text(args.price);
  push(rows, "Order", joinParts([joinParts([side === null ? null : capitalize(side), orderRow(args)], " "), price === null ? null : `at ${price}`], " "));
  const remaining = text(args.remainingBaseAmount);
  const filled = text(args.filledBaseAmount);
  push(rows, "Open", joinParts([remaining === null ? null : `${remaining} remaining`, filled === null ? null : `${filled} filled`], " · "));
  return rows;
}

function modifyRows(args: Args): LighterOrderFact[] {
  const rows: LighterOrderFact[] = [];
  const orderId = text(args.providerOrderId);
  push(rows, "Action", orderId === null ? "Modify order" : `Modify order ${orderId}`);
  const marketIndex = text(args.marketIndex);
  push(rows, "Market", marketRow(marketIndex === null ? null : `Market ${marketIndex}`, null, args.environment));
  const side = text(args.side);
  push(rows, "Order", joinParts([side === null ? null : capitalize(side), orderRow(args)], " "));
  const fromAmount = text(args.initialBaseAmount);
  const fromPrice = text(args.price);
  push(rows, "From", joinParts([fromAmount, fromPrice === null ? null : `at ${fromPrice}`], " "));
  const toAmount = text(args.requestedBaseAmount);
  const toPrice = text(args.requestedPrice);
  push(rows, "To", joinParts([toAmount, toPrice === null ? null : `at ${toPrice}`], " "));
  const filled = text(args.filledBaseAmount);
  push(rows, "Filled", filled === null ? null : `${filled} already filled`);
  return rows;
}

function cancelAllRows(args: Args): LighterOrderFact[] {
  const rows: LighterOrderFact[] = [];
  const count = typeof args.orderCount === "number" ? args.orderCount : null;
  push(rows, "Action", count === null ? "Cancel all orders" : `Cancel all ${count} active order${count === 1 ? "" : "s"}`);
  push(rows, "Market", marketRow(null, null, args.environment));
  push(rows, "Account", text(args.accountIndex));
  return rows;
}

/** Labeled facts for a Lighter order card, or `null` when this is not one. */
export function lighterOrderFacts(args: Args): readonly LighterOrderFact[] | null {
  switch (args.toolId) {
    case "lighter.order.create":
      return args.groupingType === "one-cancels-the-other" ? ocoRows(args) : createRows(args);
    case "lighter.position.close":
      return closeRows(args);
    case "lighter.order.cancel":
      return cancelRows(args);
    case "lighter.order.modify":
      return modifyRows(args);
    case "lighter.order.cancelAll":
      return cancelAllRows(args);
    default:
      return null;
  }
}
