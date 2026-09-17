import { describe, expect, it } from "vitest";
import type { LighterTradingFill } from "@shared/schemas/lighter-trading.js";
import { fillMarkers } from "../chart-fill-markers.js";

const colors = { positive: "green", negative: "red" };

function fill(overrides: Partial<LighterTradingFill>): LighterTradingFill {
  return {
    tradeId: "1",
    marketId: 1,
    symbol: "BTC",
    side: "buy",
    role: "taker",
    type: "trade",
    size: "0.5",
    price: "80000",
    value: null,
    realizedPnl: null,
    timestamp: 1_700_000_030_000,
    ...overrides,
  };
}

describe("fillMarkers", () => {
  it("places each fill on the bar it hit and collapses same-bar fills per side", () => {
    const bars = [1_700_000_000, 1_700_000_060, 1_700_000_120];
    const markers = fillMarkers([
      fill({ tradeId: "a", size: "0.5", price: "80000", timestamp: 1_700_000_030_000 }),
      fill({ tradeId: "b", size: "1.5", price: "84000", timestamp: 1_700_000_059 }),
      fill({ tradeId: "c", side: "sell", size: "1", price: "85000", timestamp: 1_700_000_130_000 }),
    ], bars, colors, 0);
    expect(markers).toEqual([
      expect.objectContaining({ time: 1_700_000_000, position: "belowBar", shape: "arrowUp", color: "green", text: "B 2 @ 83,000" }),
      expect.objectContaining({ time: 1_700_000_120, position: "aboveBar", shape: "arrowDown", color: "red", text: "S 1 @ 85,000" }),
    ]);
  });

  it("drops fills older than the loaded history and unusable rows", () => {
    const bars = [1_700_000_060];
    expect(fillMarkers([
      fill({ timestamp: 1_700_000_000_000 }),
      fill({ timestamp: 1_700_000_090_000, size: "0" }),
    ], bars, colors, 0)).toEqual([]);
    expect(fillMarkers([fill({})], [], colors, 0)).toEqual([]);
  });
});
