import { describe, expect, it } from "vitest";

import {
  lighterTradingCandleSnapshotEventSchema,
  lighterTradingCandleStatusEventSchema,
  lighterTradingCandleSubscriptionStartInputSchema,
  lighterTradingCandleSubscriptionStartResultSchema,
  lighterTradingCandleSubscriptionStopInputSchema,
  lighterTradingCandleUpdateEventSchema,
  lighterTradingListMarketsInputSchema,
  lighterTradingLiveResolutionSchema,
  lighterTradingMarketListSchema,
  lighterTradingSnapshotSchema,
} from "../lighter-trading.js";

const subscriptionId = "00000000-0000-4000-8000-000000000225";

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

  it("accepts only strict UUID-scoped candle subscription requests and results", () => {
    const input = {
      subscriptionId,
      environment: "rhc" as const,
      marketId: 7,
      resolution: "1m" as const,
    };

    expect(lighterTradingCandleSubscriptionStartInputSchema.parse(input)).toEqual(
      input,
    );
    expect(
      lighterTradingCandleSubscriptionStartResultSchema.parse({
        ...input,
        status: "started",
      }).subscriptionId,
    ).toBe(subscriptionId);
    expect(
      lighterTradingCandleSubscriptionStartInputSchema.safeParse({
        ...input,
        authToken: "must-not-cross",
      }).success,
    ).toBe(false);
    expect(lighterTradingLiveResolutionSchema.safeParse("1d").success).toBe(true);
    expect(
      lighterTradingCandleSubscriptionStartInputSchema.safeParse({
        ...input,
        resolution: "1w",
      }).success,
    ).toBe(false);
    expect(
      lighterTradingCandleSubscriptionStopInputSchema.safeParse({
        subscriptionId: "not-a-uuid",
      }).success,
    ).toBe(false);
  });

  it("validates bounded candle snapshots and updates with exact provider metadata", () => {
    const candle = {
      timestamp: 1_787_530_000_000,
      open: 4_100,
      high: 4_250,
      low: 4_050,
      close: 4_200,
      volumeBase: 8,
      volumeQuote: 33_000,
      lastTradeId: "90071992547409939999",
      providerResolution: "1m" as const,
      source: "websocket_update" as const,
    };
    const event = {
      subscriptionId,
      environment: "rhc" as const,
      marketId: 7,
      resolution: "1m" as const,
      status: "live" as const,
      providerTimestamp: 1_787_530_000_000,
      receivedAt: 1_787_530_000_050,
      candles: [candle],
    };

    expect(
      lighterTradingCandleSnapshotEventSchema.parse({
        ...event,
        candles: [{ ...candle, source: "rest_snapshot" }],
      }).candles[0]?.lastTradeId,
    ).toBe("90071992547409939999");
    expect(lighterTradingCandleUpdateEventSchema.parse(event).candles).toHaveLength(1);
    expect(
      lighterTradingCandleUpdateEventSchema.safeParse({
        ...event,
        candles: [{ ...candle, high: 4_000 }],
      }).success,
    ).toBe(false);
    expect(
      lighterTradingCandleUpdateEventSchema.safeParse({
        ...event,
        candles: [{ ...candle, source: "untrusted" }],
      }).success,
    ).toBe(false);
  });

  it("keeps connection state separate from candle data events", () => {
    const status = {
      subscriptionId,
      environment: "core" as const,
      marketId: 7,
      resolution: "5m" as const,
      status: "delayed" as const,
      providerTimestamp: null,
      receivedAt: 1_787_530_000_050,
      candles: [],
    };

    expect(lighterTradingCandleStatusEventSchema.parse(status).status).toBe(
      "delayed",
    );
    expect(
      lighterTradingCandleStatusEventSchema.safeParse({
        ...status,
        status: "update",
      }).success,
    ).toBe(false);
    expect(
      lighterTradingCandleStatusEventSchema.safeParse({
        ...status,
        candles: [{}],
      }).success,
    ).toBe(false);
  });
});
