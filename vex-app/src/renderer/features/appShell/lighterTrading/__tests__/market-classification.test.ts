import { describe, expect, it } from "vitest";
import type { LighterTradingMarket } from "@shared/schemas/lighter-trading.js";
import {
  classifyLighterMarket,
  marketProductLabel,
  marketSectionFor,
} from "../market-classification.js";

const AAPL_SPOT = market({
  marketId: 2049,
  symbol: "AAPL/USDG",
  marketType: "spot",
  baseAssetId: 4,
  quoteAssetId: 3,
});

describe("Lighter market classification", () => {
  it("keeps verified stock identity separate from its spot execution type", () => {
    const classification = classifyLighterMarket("rhc", AAPL_SPOT);

    expect(classification).toEqual({
      assetClass: "stock",
      executionType: "spot",
      section: "stocks",
      ticker: "AAPL",
    });
    expect(marketProductLabel(classification)).toBe("Stock token · Spot");
  });

  it("places a verified equity perpetual in Stocks while preserving perpetual execution", () => {
    const classification = classifyLighterMarket("rhc", market({
      marketId: 10,
      symbol: "AAPL",
      marketType: "perp",
      baseAssetId: 0,
      quoteAssetId: 0,
    }));

    expect(classification.section).toBe("stocks");
    expect(classification.executionType).toBe("perp");
    expect(marketProductLabel(classification)).toBe("Stock · Perpetual");
  });

  it("leaves non-stock and unresolved products in their provider execution sections", () => {
    const btc = market({ marketId: 1, symbol: "BTC", marketType: "perp" });
    const ethSpot = market({
      marketId: 2048,
      symbol: "ETH/USDG",
      marketType: "spot",
      baseAssetId: 1,
      quoteAssetId: 3,
    });
    const gold = market({ marketId: 40, symbol: "XAU", marketType: "perp" });
    const unknownSpot = market({
      marketId: 65_000,
      symbol: "NEW/USDG",
      marketType: "spot",
      baseAssetId: 99,
      quoteAssetId: 3,
    });

    expect(classifyLighterMarket("rhc", btc)).toMatchObject({
      assetClass: "unclassified",
      section: "perp",
    });
    expect(marketSectionFor("rhc", ethSpot)).toBe("spot");
    expect(marketSectionFor("rhc", gold)).toBe("perp");
    expect(marketSectionFor("rhc", unknownSpot)).toBe("spot");
  });

  it.each([
    ["environment", "core", AAPL_SPOT],
    ["market id", "rhc", { ...AAPL_SPOT, marketId: 2050 }],
    ["base asset id", "rhc", { ...AAPL_SPOT, baseAssetId: 5 }],
    ["quote asset id", "rhc", { ...AAPL_SPOT, quoteAssetId: 2 }],
    ["execution type", "rhc", { ...AAPL_SPOT, marketType: "perp" as const }],
    ["provider symbol", "rhc", { ...AAPL_SPOT, symbol: "AAPL/USDC" }],
  ])("fails closed when the verified %s changes", (_field, environment, changed) => {
    expect(classifyLighterMarket(environment as "core" | "rhc", changed)).toMatchObject({
      assetClass: "unclassified",
      section: changed.marketType,
    });
  });

  it("partitions every listing into exactly one popup section", () => {
    const markets = [
      AAPL_SPOT,
      market({ marketId: 10, symbol: "AAPL", marketType: "perp" }),
      market({ marketId: 1, symbol: "BTC", marketType: "perp" }),
      market({
        marketId: 2048,
        symbol: "ETH/USDG",
        marketType: "spot",
        baseAssetId: 1,
        quoteAssetId: 3,
      }),
    ];
    const sections = ["stocks", "perp", "spot"] as const;

    for (const row of markets) {
      expect(sections.filter((section) => marketSectionFor("rhc", row) === section))
        .toHaveLength(1);
    }
  });
});

function market(overrides: Partial<LighterTradingMarket>): LighterTradingMarket {
  return {
    marketId: 1,
    symbol: "BTC",
    marketType: "perp",
    status: "active",
    baseAssetId: 0,
    quoteAssetId: 0,
    minBaseAmount: "0.001",
    minQuoteAmount: "10",
    orderQuoteLimit: "100000",
    decimals: { size: 4, price: 2, quote: 6 },
    fees: { maker: "0", taker: "0.0003", makerEnabled: false, takerEnabled: true },
    ...overrides,
  };
}
