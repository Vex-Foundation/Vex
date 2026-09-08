import { describe, expect, it } from "vitest";
import type { LighterTradingMarket } from "@shared/schemas/lighter-trading.js";
import { selectDefaultLighterMarket } from "../market-selection.js";

describe("Light it up default market selection", () => {
  it("defaults Spot to the active market with the strongest provider quote volume", () => {
    const eth = market({ marketId: 2048, symbol: "ETH/USDG" });
    const qqq = market({
      marketId: 2064,
      symbol: "QQQ/USDG",
      activity24h: { tradesCount: 21, quoteVolume: 284.37 },
    });
    const spy = market({
      marketId: 2065,
      symbol: "SPY/USDG",
      activity24h: { tradesCount: 2_054, quoteVolume: 1_425_995.03 },
    });

    expect(selectDefaultLighterMarket("spot", [eth, qqq, spy])).toBe(spy);
  });

  it("ignores inactive volume and falls back safely when no active Spot market has volume", () => {
    const inactive = market({
      marketId: 2065,
      symbol: "SPY/USDG",
      status: "inactive",
      activity24h: { tradesCount: 2_054, quoteVolume: 1_425_995.03 },
    });
    const empty = market({ marketId: 2048, symbol: "ETH/USDG" });

    expect(selectDefaultLighterMarket("spot", [inactive, empty])).toBe(empty);
  });

  it("preserves the BTC preference for perpetual markets", () => {
    const eth = market({ marketId: 0, symbol: "ETH", marketType: "perp" });
    const btc = market({ marketId: 1, symbol: "BTC", marketType: "perp" });

    expect(selectDefaultLighterMarket("perp", [eth, btc])).toBe(btc);
  });
});

function market(overrides: Partial<LighterTradingMarket>): LighterTradingMarket {
  return {
    marketId: 2048,
    symbol: "ETH/USDG",
    marketType: "spot",
    status: "active",
    baseAssetId: 1,
    quoteAssetId: 3,
    minBaseAmount: "0.001",
    minQuoteAmount: "10",
    orderQuoteLimit: "100000",
    decimals: { size: 4, price: 2, quote: 6 },
    fees: { maker: "0", taker: "0", makerEnabled: true, takerEnabled: true },
    activity24h: { tradesCount: 0, quoteVolume: 0 },
    ...overrides,
  };
}
