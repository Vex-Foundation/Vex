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
    marketType: z.enum(["perp", "spot"]),
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
      })
      .strict(),
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

export type LighterTradingEnvironment = z.infer<
  typeof lighterIntegrationEnvironmentSchema
>;
export type LighterTradingResolution = z.infer<
  typeof lighterTradingResolutionSchema
>;
export type LighterTradingLiveResolution = z.infer<
  typeof lighterTradingLiveResolutionSchema
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
