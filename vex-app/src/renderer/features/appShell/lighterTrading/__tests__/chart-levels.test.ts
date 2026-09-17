import { describe, expect, it } from "vitest";
import type { LighterOpenOrderRow, LighterPositionRow } from "../account-model.js";
import { buildChartLevels } from "../chart-levels.js";

const LONG: LighterPositionRow = {
  marketId: 1,
  symbol: "BTC",
  side: "long",
  size: "0.25",
  entryPrice: "64000",
  value: "16000",
  unrealizedPnl: "12.75",
  liquidationPrice: "41000",
  initialMarginFraction: 1_000,
  marginMode: "cross",
  allocatedMargin: "1600",
};

function order(overrides: Partial<LighterOpenOrderRow>): LighterOpenOrderRow {
  return {
    orderId: "order-1",
    clientOrderId: null,
    marketId: 1,
    symbol: "BTC",
    side: "sell",
    type: "limit",
    timeInForce: "good-till-time",
    reduceOnly: false,
    triggerPrice: null,
    triggerStatus: null,
    triggeredAt: null,
    orderExpiry: null,
    price: "70000",
    size: "0.25",
    filled: null,
    remaining: "0.25",
    status: "open",
    createdAt: null,
    ...overrides,
  };
}

describe("buildChartLevels", () => {
  it("draws entry, liquidation, and the protective legs by role", () => {
    const orders = [
      order({ orderId: "sl", type: "stop-loss-limit", reduceOnly: true, triggerPrice: "60000", price: "59900" }),
      order({ orderId: "tp", type: "take-profit-limit", reduceOnly: true, triggerPrice: "72000", price: "72000" }),
    ];
    expect(buildChartLevels(1, [LONG], orders)).toEqual([
      { key: "entry:1", kind: "entry", price: 64_000, title: "Entry", side: "buy" },
      { key: "liq:1", kind: "liquidation", price: 41_000, title: "Liq.", side: "buy" },
      { key: "order:sl", kind: "stopLoss", price: 60_000, title: "SL", side: "sell" },
      { key: "order:tp", kind: "takeProfit", price: 72_000, title: "TP", side: "sell" },
    ]);
  });

  it("labels other resting orders by side and remaining size, and ignores other markets", () => {
    const orders = [
      order({ orderId: "bid", side: "buy", price: "62000", remaining: "0.1" }),
      order({ orderId: "other", marketId: 2, price: "3000" }),
    ];
    expect(buildChartLevels(1, [], orders)).toEqual([
      { key: "order:bid", kind: "order", price: 62_000, title: "Buy 0.1", side: "buy" },
    ]);
    expect(buildChartLevels(3, [LONG], orders)).toEqual([]);
  });

  it("skips a position without a liquidation price and orders without a price", () => {
    expect(buildChartLevels(1, [{ ...LONG, liquidationPrice: null }], [order({ price: null as never, remaining: null })])).toEqual([
      { key: "entry:1", kind: "entry", price: 64_000, title: "Entry", side: "buy" },
    ]);
  });
});
