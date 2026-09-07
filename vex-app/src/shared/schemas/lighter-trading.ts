import { z } from "zod";

import { lighterIntegrationEnvironmentSchema } from "./lighter-integration.js";

export const lighterTradingResolutionSchema = z.enum([
  "1m",
  "5m",
  "15m",
  "30m",
  "1h",
  "4h",
  "12h",
  "1d",
  "1w",
]);

export const lighterTradingLiveResolutionSchema = z.enum([
  "1m",
  "5m",
  "15m",
  "30m",
  "1h",
  "4h",
  "12h",
  "1d",
]);

export const lighterTradingMarketTypeSchema = z.enum(["perp", "spot"]);

const marketIdSchema = z.number().int().min(0).max(65_535);
const assetIdSchema = z.number().int().nonnegative();
const decimalStringSchema = z
  .string()
  .min(1)
  .max(96)
  .regex(/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/);
const unsignedDecimalStringSchema = z
  .string()
  .min(1)
  .max(96)
  .regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/);
const finiteOrNullSchema = z.number().finite().nullable();

export const lighterTradingMarketSchema = z
  .object({
    marketId: marketIdSchema,
    symbol: z.string().min(1).max(48).regex(/^[A-Za-z0-9._:/-]+$/),
    marketType: lighterTradingMarketTypeSchema,
    status: z.enum(["active", "inactive"]),
    baseAssetId: assetIdSchema,
    quoteAssetId: assetIdSchema,
    minBaseAmount: unsignedDecimalStringSchema,
    minQuoteAmount: unsignedDecimalStringSchema,
    orderQuoteLimit: unsignedDecimalStringSchema,
    decimals: z
      .object({
        size: z.number().int().min(0).max(18),
        price: z.number().int().min(0).max(18),
        quote: z.number().int().min(0).max(18),
      })
      .strict(),
    fees: z
      .object({
        maker: decimalStringSchema,
        taker: decimalStringSchema,
        makerEnabled: z.boolean(),
        takerEnabled: z.boolean(),
      })
      .strict(),
    activity24h: z
      .object({
        tradesCount: z.number().finite().nonnegative().nullable(),
        quoteVolume: z.number().finite().nonnegative().nullable(),
      })
      .strict(),
    statistics: z
      .object({
        lastTradePrice: z.number().finite().nonnegative().nullable(),
        priceChange24h: finiteOrNullSchema,
        openInterestBase: z.number().finite().nonnegative().nullable(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const lighterTradingListMarketsInputSchema = z
  .object({ environment: lighterIntegrationEnvironmentSchema })
  .strict();

export const lighterTradingMarketListSchema = z
  .object({
    environment: lighterIntegrationEnvironmentSchema,
    retrievedAt: z.number().int().nonnegative(),
    markets: z.array(lighterTradingMarketSchema).max(500),
  })
  .strict();

export const lighterTradingSnapshotInputSchema = z
  .object({
    environment: lighterIntegrationEnvironmentSchema,
    marketId: marketIdSchema,
    resolution: lighterTradingResolutionSchema,
  })
  .strict();

export const lighterTradingCandleSubscriptionStartInputSchema = z
  .object({
    subscriptionId: z.string().uuid(),
    environment: lighterIntegrationEnvironmentSchema,
    marketId: marketIdSchema,
    resolution: lighterTradingLiveResolutionSchema,
  })
  .strict();

export const lighterTradingCandleSubscriptionStartResultSchema = z
  .object({
    subscriptionId: z.string().uuid(),
    environment: lighterIntegrationEnvironmentSchema,
    marketId: marketIdSchema,
    resolution: lighterTradingLiveResolutionSchema,
    status: z.literal("started"),
  })
  .strict();

export const lighterTradingCandleSubscriptionStopInputSchema = z
  .object({ subscriptionId: z.string().uuid() })
  .strict();

export const lighterTradingCandleSubscriptionStopResultSchema = z
  .object({
    subscriptionId: z.string().uuid(),
    status: z.literal("stopped"),
  })
  .strict();

const lighterTradingBookRowSchema = z
  .object({
    orderId: z.string().min(1).max(128).regex(/^\d+$/),
    price: unsignedDecimalStringSchema,
    size: unsignedDecimalStringSchema,
  })
  .strict();

const lighterTradingTradeSchema = z
  .object({
    tradeId: z.string().min(1).max(128).regex(/^\d+$/),
    type: z.enum(["trade", "liquidation", "deleverage", "market-settlement"]),
    price: unsignedDecimalStringSchema,
    size: unsignedDecimalStringSchema,
    usdAmount: unsignedDecimalStringSchema,
    takerSide: z.enum(["buy", "sell"]),
    timestamp: z.number().int().nonnegative(),
  })
  .strict();

export const lighterTradingCandleSchema = z
  .object({
    timestamp: z.number().int().nonnegative(),
    open: z.number().finite(),
    high: z.number().finite(),
    low: z.number().finite(),
    close: z.number().finite(),
    volumeBase: z.number().finite().nonnegative(),
    volumeQuote: z.number().finite().nonnegative(),
    lastTradeId: z.string().min(1).max(128).regex(/^\d+$/).optional(),
    providerResolution: lighterTradingResolutionSchema.optional(),
    source: z.enum(["rest_snapshot", "websocket_update"]).optional(),
  })
  .strict()
  .refine(
    (candle) =>
      candle.high >= Math.max(candle.open, candle.close, candle.low) &&
      candle.low <= Math.min(candle.open, candle.close, candle.high),
    { message: "Invalid OHLC candle bounds." },
  );

export const lighterTradingStreamCandleSchema = lighterTradingCandleSchema
  .safeExtend({
    lastTradeId: z.string().min(1).max(128).regex(/^\d+$/),
    providerResolution: lighterTradingLiveResolutionSchema,
    source: z.enum(["rest_snapshot", "websocket_update"]),
  })
  .strict();

const lighterTradingCandleEventBaseSchema = z
  .object({
    subscriptionId: z.string().uuid(),
    environment: lighterIntegrationEnvironmentSchema,
    marketId: marketIdSchema,
    resolution: lighterTradingLiveResolutionSchema,
    providerTimestamp: z.number().int().nonnegative(),
    receivedAt: z.number().int().nonnegative(),
  })
  .strict();

export const lighterTradingCandleSnapshotEventSchema =
  lighterTradingCandleEventBaseSchema
    .extend({
      status: z.literal("live"),
      candles: z.array(lighterTradingStreamCandleSchema).min(1).max(500),
    })
    .strict();

export const lighterTradingCandleUpdateEventSchema =
  lighterTradingCandleEventBaseSchema
    .extend({
      status: z.literal("live"),
      candles: z.array(lighterTradingStreamCandleSchema).min(1).max(50),
    })
    .strict();

export const lighterTradingCandleConnectionStatusSchema = z.enum([
  "connecting",
  "live",
  "reconnecting",
  "delayed",
  "unavailable",
  "stopped",
]);

export const lighterTradingCandleStatusEventSchema =
  lighterTradingCandleEventBaseSchema
    .extend({
      status: lighterTradingCandleConnectionStatusSchema,
      providerTimestamp: z.number().int().nonnegative().nullable(),
      candles: z.array(lighterTradingStreamCandleSchema).max(0),
    })
    .strict();

export const lighterTradingPublicMarketSubscriptionStartInputSchema = z
  .object({
    subscriptionId: z.string().uuid(),
    environment: lighterIntegrationEnvironmentSchema,
    marketId: marketIdSchema,
    marketType: lighterTradingMarketTypeSchema,
  })
  .strict();

export const lighterTradingPublicMarketSubscriptionStartResultSchema =
  lighterTradingPublicMarketSubscriptionStartInputSchema
    .extend({ status: z.literal("started") })
    .strict();

export const lighterTradingPublicMarketSubscriptionStopInputSchema = z
  .object({ subscriptionId: z.string().uuid() })
  .strict();

export const lighterTradingPublicMarketSubscriptionStopResultSchema = z
  .object({
    subscriptionId: z.string().uuid(),
    status: z.literal("stopped"),
  })
  .strict();

const lighterTradingPublicMarketEventBaseSchema = z
  .object({
    subscriptionId: z.string().uuid(),
    environment: lighterIntegrationEnvironmentSchema,
    marketId: marketIdSchema,
    marketType: lighterTradingMarketTypeSchema,
    providerTimestamp: z.number().int().nonnegative(),
    receivedAt: z.number().int().nonnegative(),
  })
  .strict();

const lighterTradingPublicBookLevelSchema = z
  .object({
    price: unsignedDecimalStringSchema,
    size: unsignedDecimalStringSchema,
  })
  .strict();

export const lighterTradingPublicBookEventSchema =
  lighterTradingPublicMarketEventBaseSchema
    .extend({
      status: z.literal("live"),
      nonce: z.string().min(1).max(128).regex(/^\d+$/),
      book: z
        .object({
          asks: z.array(lighterTradingPublicBookLevelSchema).max(40),
          bids: z.array(lighterTradingPublicBookLevelSchema).max(40),
        })
        .strict(),
    })
    .strict();

export const lighterTradingPublicTradesEventSchema =
  lighterTradingPublicMarketEventBaseSchema
    .extend({
      status: z.literal("live"),
      nonce: z.string().min(1).max(128).regex(/^\d+$/),
      trades: z.array(lighterTradingTradeSchema).min(1).max(50),
    })
    .strict();

export const lighterTradingPublicStatsEventSchema =
  lighterTradingPublicMarketEventBaseSchema
    .extend({
      status: z.literal("live"),
      stats: z
        .object({
          lastTradePrice: finiteOrNullSchema,
          indexPrice: finiteOrNullSchema,
          markPrice: finiteOrNullSchema,
          midPrice: finiteOrNullSchema,
          bestAskPrice: finiteOrNullSchema,
          bestBidPrice: finiteOrNullSchema,
          openInterestQuote: finiteOrNullSchema,
          daily: z
            .object({
              baseTokenVolume: finiteOrNullSchema,
              quoteTokenVolume: finiteOrNullSchema,
              priceLow: finiteOrNullSchema,
              priceHigh: finiteOrNullSchema,
              priceChange: finiteOrNullSchema,
            })
            .strict(),
          funding: z
            .object({
              clampSmall: decimalStringSchema.nullable(),
              clampBig: decimalStringSchema.nullable(),
              baseInterestRate: decimalStringSchema.nullable(),
              currentRate: decimalStringSchema.nullable(),
              lastRate: decimalStringSchema.nullable(),
              timestamp: z.number().int().nonnegative().nullable(),
              premium: decimalStringSchema.nullable(),
            })
            .strict(),
        })
        .strict(),
    })
    .strict();

export const lighterTradingPublicMarketStatusEventSchema =
  lighterTradingPublicMarketEventBaseSchema
    .extend({
      status: lighterTradingCandleConnectionStatusSchema,
      bookStatus: lighterTradingCandleConnectionStatusSchema,
      tradesStatus: lighterTradingCandleConnectionStatusSchema,
      statsStatus: lighterTradingCandleConnectionStatusSchema,
      providerTimestamp: z.number().int().nonnegative().nullable(),
    })
    .strict();

export const lighterTradingSnapshotSchema = z
  .object({
    environment: lighterIntegrationEnvironmentSchema,
    retrievedAt: z.number().int().nonnegative(),
    market: lighterTradingMarketSchema,
    detail: z
      .object({
        lastTradePrice: finiteOrNullSchema,
        openInterest: finiteOrNullSchema,
        daily: z
          .object({
            tradesCount: finiteOrNullSchema,
            baseTokenVolume: finiteOrNullSchema,
            quoteTokenVolume: finiteOrNullSchema,
            priceLow: finiteOrNullSchema,
            priceHigh: finiteOrNullSchema,
            priceChange: finiteOrNullSchema,
          })
          .strict(),
        funding: z
          .object({
            clampSmall: decimalStringSchema.nullable(),
            clampBig: decimalStringSchema.nullable(),
            baseInterestRate: decimalStringSchema.nullable(),
          })
          .strict(),
      })
      .strict(),
    book: z
      .object({
        asks: z.array(lighterTradingBookRowSchema).max(40),
        bids: z.array(lighterTradingBookRowSchema).max(40),
      })
      .strict(),
    trades: z.array(lighterTradingTradeSchema).max(40),
    candles: z.array(lighterTradingCandleSchema).max(500),
  })
  .strict();

// Authenticated Light it up account panel. The renderer supplies only the
// environment; the main process resolves the owning account from the unlocked
// trading scope and never returns tokens or key material. Positions and
// balances are public account-index reads; open orders use a short-lived
// read-only auth derived in main.
export const lighterTradingAccountInputSchema = z
  .object({ environment: lighterIntegrationEnvironmentSchema })
  .strict();

export const lighterTradingAccountStatusSchema = z.enum(["ready", "unavailable"]);

const lighterTradingPositionSchema = z
  .object({
    marketId: marketIdSchema,
    symbol: z.string().min(1).max(48),
    side: z.enum(["long", "short"]),
    size: unsignedDecimalStringSchema,
    entryPrice: unsignedDecimalStringSchema.nullable(),
    value: unsignedDecimalStringSchema.nullable(),
    unrealizedPnl: decimalStringSchema.nullable(),
    liquidationPrice: unsignedDecimalStringSchema.nullable(),
  })
  .strict();

const lighterTradingOpenOrderSchema = z
  .object({
    orderId: z.string().min(1).max(128),
    // Lighter also exposes a numeric client_order_index, but the string form is
    // the only renderer-safe identity because provider IDs can exceed JS
    // integer precision. Main emits null when the exact string is unavailable.
    clientOrderId: z.string().min(1).max(128).nullable(),
    marketId: marketIdSchema,
    symbol: z.string().min(1).max(48),
    side: z.enum(["buy", "sell"]),
    type: z.string().min(1).max(32).nullable(),
    timeInForce: z.string().min(1).max(32).nullable(),
    reduceOnly: z.boolean().nullable(),
    triggerPrice: unsignedDecimalStringSchema.nullable(),
    triggerStatus: z.string().min(1).max(32).nullable(),
    triggeredAt: z.number().int().nonnegative().nullable(),
    orderExpiry: z.number().int().nonnegative().nullable(),
    price: unsignedDecimalStringSchema.nullable(),
    size: unsignedDecimalStringSchema.nullable(),
    filled: unsignedDecimalStringSchema.nullable(),
    remaining: unsignedDecimalStringSchema.nullable(),
    status: z.string().min(1).max(32).nullable(),
    createdAt: z.number().int().nonnegative().nullable(),
  })
  .strict();

const lighterTradingAssetSchema = z
  .object({
    assetId: assetIdSchema,
    symbol: z.string().min(1).max(48),
    balance: unsignedDecimalStringSchema,
    available: unsignedDecimalStringSchema.nullable(),
    marginMode: z.enum(["enabled", "disabled"]).nullable(),
  })
  .strict();

const lighterTradingAccountSummarySchema = z
  .object({
    collateral: decimalStringSchema.nullable(),
    availableBalance: decimalStringSchema.nullable(),
    unrealizedPnl: decimalStringSchema.nullable(),
  })
  .strict();

export const lighterTradingAccountSchema = z
  .object({
    environment: lighterIntegrationEnvironmentSchema,
    retrievedAt: z.number().int().nonnegative(),
    status: lighterTradingAccountStatusSchema,
    accountIndex: z.number().int().nonnegative().nullable(),
    openOrdersAvailable: z.boolean(),
    // Required so a bounded snapshot can never be mistaken for a complete one.
    openOrdersTruncated: z.boolean(),
    summary: lighterTradingAccountSummarySchema.nullable(),
    assets: z.array(lighterTradingAssetSchema).max(200),
    positions: z.array(lighterTradingPositionSchema).max(200),
    openOrders: z.array(lighterTradingOpenOrderSchema).max(200),
  })
  .strict();

export type LighterTradingEnvironment = z.infer<
  typeof lighterIntegrationEnvironmentSchema
>;
export type LighterTradingResolution = z.infer<
  typeof lighterTradingResolutionSchema
>;
export type LighterTradingLiveResolution = z.infer<
  typeof lighterTradingLiveResolutionSchema
>;
export type LighterTradingMarketType = z.infer<
  typeof lighterTradingMarketTypeSchema
>;
export type LighterTradingMarket = z.infer<typeof lighterTradingMarketSchema>;
export type LighterTradingListMarketsInput = z.infer<
  typeof lighterTradingListMarketsInputSchema
>;
export type LighterTradingMarketList = z.infer<
  typeof lighterTradingMarketListSchema
>;
export type LighterTradingSnapshotInput = z.infer<
  typeof lighterTradingSnapshotInputSchema
>;
export type LighterTradingSnapshot = z.infer<
  typeof lighterTradingSnapshotSchema
>;
export type LighterTradingCandle = z.infer<typeof lighterTradingCandleSchema>;
export type LighterTradingStreamCandle = z.infer<
  typeof lighterTradingStreamCandleSchema
>;
export type LighterTradingCandleSubscriptionStartInput = z.infer<
  typeof lighterTradingCandleSubscriptionStartInputSchema
>;
export type LighterTradingCandleSubscriptionStartResult = z.infer<
  typeof lighterTradingCandleSubscriptionStartResultSchema
>;
export type LighterTradingCandleSubscriptionStopInput = z.infer<
  typeof lighterTradingCandleSubscriptionStopInputSchema
>;
export type LighterTradingCandleSubscriptionStopResult = z.infer<
  typeof lighterTradingCandleSubscriptionStopResultSchema
>;
export type LighterTradingCandleSnapshotEvent = z.infer<
  typeof lighterTradingCandleSnapshotEventSchema
>;
export type LighterTradingCandleUpdateEvent = z.infer<
  typeof lighterTradingCandleUpdateEventSchema
>;
export type LighterTradingCandleConnectionStatus = z.infer<
  typeof lighterTradingCandleConnectionStatusSchema
>;
export type LighterTradingCandleStatusEvent = z.infer<
  typeof lighterTradingCandleStatusEventSchema
>;
export type LighterTradingPublicMarketSubscriptionStartInput = z.infer<
  typeof lighterTradingPublicMarketSubscriptionStartInputSchema
>;
export type LighterTradingPublicMarketSubscriptionStartResult = z.infer<
  typeof lighterTradingPublicMarketSubscriptionStartResultSchema
>;
export type LighterTradingPublicMarketSubscriptionStopInput = z.infer<
  typeof lighterTradingPublicMarketSubscriptionStopInputSchema
>;
export type LighterTradingPublicMarketSubscriptionStopResult = z.infer<
  typeof lighterTradingPublicMarketSubscriptionStopResultSchema
>;
export type LighterTradingPublicBookEvent = z.infer<
  typeof lighterTradingPublicBookEventSchema
>;
export type LighterTradingPublicTradesEvent = z.infer<
  typeof lighterTradingPublicTradesEventSchema
>;
export type LighterTradingPublicStatsEvent = z.infer<
  typeof lighterTradingPublicStatsEventSchema
>;
export type LighterTradingPublicMarketStatusEvent = z.infer<
  typeof lighterTradingPublicMarketStatusEventSchema
>;
export type LighterTradingAccountInput = z.infer<
  typeof lighterTradingAccountInputSchema
>;
export type LighterTradingAccount = z.infer<typeof lighterTradingAccountSchema>;
export type LighterTradingAsset = z.infer<typeof lighterTradingAssetSchema>;
export type LighterTradingPosition = z.infer<typeof lighterTradingPositionSchema>;
export type LighterTradingOpenOrder = z.infer<
  typeof lighterTradingOpenOrderSchema
>;
