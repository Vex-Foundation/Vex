import { positionProtection, type LighterOpenOrderRow, type LighterPositionRow } from "./account-model.js";
import { formatDecimalString } from "./format.js";

export type ChartLevelKind = "entry" | "liquidation" | "takeProfit" | "stopLoss" | "order";

/** One horizontal price line the chart draws for the active market. */
export interface ChartLevel {
  readonly key: string;
  readonly kind: ChartLevelKind;
  readonly price: number;
  /** Axis label, exchange register: `Entry`, `Liq.`, `TP`, `SL`, `Buy 0.25`. */
  readonly title: string;
  readonly side: "buy" | "sell";
}

function finite(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/**
 * The account's footprint on one market: the position's entry and liquidation,
 * its protective legs, and every other resting order. Protective legs are
 * labeled by role so a stop reads as a stop, not as a sell.
 */
export function buildChartLevels(
  marketId: number,
  positions: readonly LighterPositionRow[],
  orders: readonly LighterOpenOrderRow[],
): ChartLevel[] {
  const levels: ChartLevel[] = [];
  const claimed = new Set<string>();
  for (const position of positions) {
    if (position.marketId !== marketId) continue;
    const side = position.side === "long" ? "buy" : "sell";
    const entry = finite(position.entryPrice);
    if (entry !== null) levels.push({ key: `entry:${position.marketId}`, kind: "entry", price: entry, title: "Entry", side });
    const liquidation = finite(position.liquidationPrice);
    if (liquidation !== null) {
      levels.push({ key: `liq:${position.marketId}`, kind: "liquidation", price: liquidation, title: "Liq.", side });
    }
    const { stopLoss, takeProfit } = positionProtection(position, orders);
    for (const [kind, order, title] of [["stopLoss", stopLoss, "SL"], ["takeProfit", takeProfit, "TP"]] as const) {
      const price = order === null ? null : finite(order.triggerPrice);
      if (order === null || price === null) continue;
      claimed.add(order.orderId);
      levels.push({ key: `order:${order.orderId}`, kind, price, title, side: order.side });
    }
  }
  for (const order of orders) {
    if (order.marketId !== marketId || claimed.has(order.orderId)) continue;
    const price = finite(order.triggerPrice) ?? finite(order.price);
    if (price === null) continue;
    const label = order.side === "buy" ? "Buy" : "Sell";
    levels.push({
      key: `order:${order.orderId}`,
      kind: "order",
      price,
      title: `${label} ${formatDecimalString(order.remaining)}`,
      side: order.side,
    });
  }
  return levels;
}
