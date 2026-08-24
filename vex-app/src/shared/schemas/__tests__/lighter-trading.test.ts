import { describe, expect, it } from "vitest";

import {
  lighterTradingListMarketsInputSchema,
  lighterTradingMarketListSchema,
  lighterTradingSnapshotSchema,
} from "../lighter-trading.js";

const market = {
  marketId: 7,
  symbol: "ETH-USD",
  marketType: "perp" as const,
  status: "active" as const,
  baseAssetId: 1,
  quoteAssetId: 2,
  minBaseAmount: "0.001",
  minQuoteAmount: "10",
  orderQuoteLimit: "1000000",
  decimals: { size: 4, price: 2, quote: 6 },
  fees: { maker: "0", taker: "0" },
};

describe("lighter trading shared contracts", () => {
  it("accepts the bounded renderer-safe market list", () => {
    const parsed = lighterTradingMarketListSchema.parse({
      environment: "rhc",
      retrievedAt: 1_787_530_000_000,
      markets: [market],
    });

    expect(parsed.markets[0]?.marketId).toBe(7);
  });

  it("rejects unknown renderer input keys", () => {
    expect(
      lighterTradingListMarketsInputSchema.safeParse({
        environment: "core",
        authToken: "must-not-cross",
      }).success,
    ).toBe(false);
  });

  it("keeps exact provider ids as strings and validates OHLC bounds", () => {
    const valid = {
      environment: "core" as const,
      retrievedAt: 1_787_530_000_000,
      market,
      detail: {
        lastTradePrice: 4_200,
        openInterest: 12_300,
        daily: {
          tradesCount: 120,
          baseTokenVolume: 30,
          quoteTokenVolume: 126_000,
          priceLow: 4_000,
          priceHigh: 4_300,
          priceChange: 1.2,
        },
        funding: {
          clampSmall: "-0.0001",
          clampBig: "0.0001",
          baseInterestRate: "0.00001",
        },
      },
      book: {
        asks: [{ orderId: "90071992547409931234", price: "4201", size: "2" }],
        bids: [{ orderId: "90071992547409931233", price: "4199", size: "1" }],
      },
      trades: [
        {
          tradeId: "90071992547409939999",
          type: "trade" as const,
          price: "4200",
          size: "0.1",
          usdAmount: "420",
          takerSide: "buy" as const,
          timestamp: 1_787_530_000_000,
        },
      ],
      candles: [
        {
          timestamp: 1_787_530_000_000,
          open: 4_100,
          high: 4_250,
          low: 4_050,
          close: 4_200,
          volumeBase: 8,
          volumeQuote: 33_000,
        },
      ],
    };

    expect(lighterTradingSnapshotSchema.parse(valid).book.asks[0]?.orderId).toBe(
      "90071992547409931234",
    );
    expect(
      lighterTradingSnapshotSchema.safeParse({
        ...valid,
        candles: [{ ...valid.candles[0], high: 4_000 }],
      }).success,
    ).toBe(false);
  });
});
