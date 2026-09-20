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
const marginFractionSchema = z.number().int().min(1).max(10_000);

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
    /**
     * Perpetual margin fractions on Lighter's 10000 scale (10000 = 1x). Null
     * for spot markets and for a perp whose detail did not report them.
     */
    margin: z
      .object({
        defaultInitialMarginFraction: marginFractionSchema,
        minInitialMarginFraction: marginFractionSchema,
        maintenanceMarginFraction: marginFractionSchema,
      })
      .strict()
      .nullable()
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

// Older-history page for the chart's scroll-back backfill. `count` is bounded
// by the provider read (300 per request); `endTimestamp` is the exclusive
// upper bound in ms, i.e. the oldest loaded candle's open minus one.
export const lighterTradingCandleHistoryInputSchema = z
  .object({
    environment: lighterIntegrationEnvironmentSchema,
    marketId: marketIdSchema,
    resolution: lighterTradingResolutionSchema,
    endTimestamp: z.number().int().nonnegative(),
    count: z.number().int().min(1).max(300),
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

/**
 * Main's authenticated account stream saw evidence for the bound account. It
 * carries no order data: the renderer refreshes its REST reads in response,
 * which keeps every account figure on the one projection main already vets.
 */
export const lighterTradingAccountActivityEventSchema = z
  .object({
    environment: lighterIntegrationEnvironmentSchema,
    accountIndex: z.number().int().nonnegative(),
    kind: z.enum(["orders", "trades", "positions"]),
    at: z.number().int().nonnegative(),
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

export const lighterTradingCandleHistorySchema = z
  .object({
    environment: lighterIntegrationEnvironmentSchema,
    marketId: marketIdSchema,
    resolution: lighterTradingResolutionSchema,
    retrievedAt: z.number().int().nonnegative(),
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

/**
 * Why an account panel has nothing to show. These are STATES, not failures:
 * the read succeeded and the honest answer is that no account is readable yet.
 * A provider failure is not in here; it arrives as a `Result` error with its
 * own code so the panel can offer retry only where retry can help.
 *
 * - `locked_vault`: the vault is locked, so no trading scope is readable.
 * - `not_onboarded`: the vault is unlocked and holds no Lighter trading key.
 * - `ambiguous_account`: several distinct accounts are onboarded and the
 *   renderer supplies no account identity, so main refuses to pick one.
 */
export const lighterTradingAccountUnavailableReasonSchema = z.enum([
  "locked_vault",
  "not_onboarded",
  "ambiguous_account",
]);

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
    /** The position row's own margin terms; null when Lighter's value was unreadable. */
    initialMarginFraction: marginFractionSchema.nullable(),
    marginMode: z.enum(["cross", "isolated"]).nullable(),
    allocatedMargin: unsignedDecimalStringSchema.nullable(),
  })
  .strict();

/**
 * The margin terms Lighter holds for a market on this account, position or
 * not. Lighter keeps a position row per market once leverage was ever set, so
 * a 0-size row still carries the account's own terms; `positions` drops those
 * rows, this list keeps their terms.
 */
const lighterTradingMarginTermSchema = z
  .object({
    marketId: marketIdSchema,
    initialMarginFraction: marginFractionSchema,
    marginMode: z.enum(["cross", "isolated"]).nullable(),
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

/**
 * The account's most recent fills, newest first. The read needs the same
 * derived read-only authorization as open orders; `available` is false when
 * none could be derived, which is a state and not a failure.
 */
export const lighterTradingFillsInputSchema = z
  .object({
    environment: lighterIntegrationEnvironmentSchema,
    limit: z.number().int().min(1).max(100).optional(),
  })
  .strict();

const lighterTradingFillSchema = z
  .object({
    tradeId: z.string().min(1).max(128),
    // Exact provider order identity for this account's side of the trade.
    // A market can have several simultaneous orders, so tradeId alone cannot
    // tie later account activity back to the desk order being followed.
    orderId: z.string().min(1).max(128),
    marketId: marketIdSchema,
    symbol: z.string().min(1).max(48),
    side: z.enum(["buy", "sell"]),
    role: z.enum(["maker", "taker"]),
    // Lighter's own trade kind: "trade", "liquidation", "deleverage", …
    type: z.string().min(1).max(32),
    size: unsignedDecimalStringSchema,
    price: unsignedDecimalStringSchema,
    value: unsignedDecimalStringSchema.nullable(),
    // Realized on this fill for THIS account; null when the provider reports none.
    realizedPnl: decimalStringSchema.nullable(),
    timestamp: z.number().int().nonnegative(),
  })
  .strict();

export const lighterTradingFillsSchema = z
  .object({
    environment: lighterIntegrationEnvironmentSchema,
    retrievedAt: z.number().int().nonnegative(),
    accountIndex: z.number().int().nonnegative().nullable(),
    available: z.boolean(),
    // True when the bounded provider page may omit older fills. Consumers
    // must not treat a partial page as the complete fill total of an order.
    truncated: z.boolean(),
    fills: z.array(lighterTradingFillSchema).max(100),
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
    // Null exactly when `status` is "ready".
    unavailableReason: lighterTradingAccountUnavailableReasonSchema.nullable(),
    accountIndex: z.number().int().nonnegative().nullable(),
    openOrdersAvailable: z.boolean(),
    // Why the open-orders lane is empty when `openOrdersAvailable` is false:
    // "no_read_auth" means the vault is locked (the user can fix that);
    // "read_failed" means the provider read failed (retry, not unlock).
    openOrdersUnavailableReason: z.enum(["no_read_auth", "read_failed"]).optional(),
    // Required so a bounded snapshot can never be mistaken for a complete one.
    openOrdersTruncated: z.boolean(),
    summary: lighterTradingAccountSummarySchema.nullable(),
    assets: z.array(lighterTradingAssetSchema).max(200),
    positions: z.array(lighterTradingPositionSchema).max(200),
    marginTerms: z.array(lighterTradingMarginTermSchema).max(200),
    openOrders: z.array(lighterTradingOpenOrderSchema).max(200),
  })
  .strict();

export type LighterTradingEnvironment = z.infer<
  typeof lighterIntegrationEnvironmentSchema
>;

// Desk lane: the Lighter desk's own buttons (ticket Long/Short, position
// Close, order Cancel) hand main a selector only. Main runs the same prepare
// tools the AI lane uses and enqueues an approval; nothing signs until the
// user confirms the card.
const deskTimeInForceSchema = z.enum([
  "immediate-or-cancel",
  "good-till-time",
  "post-only",
]);
const deskExpiryMinutesSchema = z.number().int().min(5).max(43_200);
const deskSideSchema = z.enum(["buy", "sell"]);

export const lighterDeskOrderDraftSchema = z.discriminatedUnion("mode", [
  z
    .object({
      mode: z.literal("market"),
      side: deskSideSchema,
      baseAmount: unsignedDecimalStringSchema,
      worstPrice: unsignedDecimalStringSchema,
      reduceOnly: z.boolean(),
    })
    .strict(),
  z
    .object({
      mode: z.literal("limit"),
      side: deskSideSchema,
      baseAmount: unsignedDecimalStringSchema,
      limitPrice: unsignedDecimalStringSchema,
      timeInForce: deskTimeInForceSchema,
      orderExpiryOffsetMinutes: deskExpiryMinutesSchema,
      reduceOnly: z.boolean(),
    })
    .strict(),
  z
    .object({
      mode: z.enum(["stop-loss", "take-profit"]),
      side: deskSideSchema,
      baseAmount: unsignedDecimalStringSchema,
      triggerPrice: unsignedDecimalStringSchema,
      worstPrice: unsignedDecimalStringSchema,
      reduceOnly: z.literal(true),
    })
    .strict(),
  z
    .object({
      mode: z.enum(["stop-loss-limit", "take-profit-limit"]),
      side: deskSideSchema,
      baseAmount: unsignedDecimalStringSchema,
      triggerPrice: unsignedDecimalStringSchema,
      limitPrice: unsignedDecimalStringSchema,
      timeInForce: deskTimeInForceSchema,
      orderExpiryOffsetMinutes: deskExpiryMinutesSchema,
      reduceOnly: z.literal(true),
    })
    .strict(),
  z
    .object({
      mode: z.literal("oco"),
      side: deskSideSchema,
      baseAmount: unsignedDecimalStringSchema,
      stopLossTriggerPrice: unsignedDecimalStringSchema,
      stopLossPrice: unsignedDecimalStringSchema,
      takeProfitTriggerPrice: unsignedDecimalStringSchema,
      takeProfitPrice: unsignedDecimalStringSchema,
    })
    .strict(),
]);

export const lighterDeskActionSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("order"),
      marketId: marketIdSchema,
      draft: lighterDeskOrderDraftSchema,
    })
    .strict(),
  z.object({ kind: z.literal("close"), marketId: marketIdSchema }).strict(),
  z
    .object({
      kind: z.literal("cancel"),
      marketId: marketIdSchema,
      orderId: z.string().min(1).max(40).regex(/^[1-9][0-9]*$/),
    })
    .strict(),
  // The account-setup modal's three steps (design: single-click chain, no
  // model turn). Each still prepares a real approval, then the modal
  // auto-confirms it exactly like the ticket's own skip-close-confirm path.
  z
    .object({ kind: z.literal("onboarding_deposit"), amountIn: unsignedDecimalStringSchema })
    .strict(),
  z.object({ kind: z.literal("onboarding_key") }).strict(),
  z.object({ kind: z.literal("onboarding_fee") }).strict(),
]);

export const lighterDeskPrepareInputSchema = z
  .object({
    sessionId: z.string().uuid(),
    environment: lighterIntegrationEnvironmentSchema,
    action: lighterDeskActionSchema,
  })
  .strict();

export const lighterDeskPrepareResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("enqueued"), approvalId: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("refused"), reason: z.string().min(1) }).strict(),
]);

/**
 * The ticket gate's checklist: where this session's wallet stands on the
 * three onboarding steps the chat walks through. Read-only; `fee` is
 * `not_required` where Vex collects no fee for the deployment.
 */
export const lighterOnboardingChecklistInputSchema = z
  .object({
    sessionId: z.string().uuid(),
    environment: lighterIntegrationEnvironmentSchema,
  })
  .strict();

const lighterOnboardingStepSchema = z.enum(["done", "todo"]);

export const lighterOnboardingProgressSchema = z.enum([
  "not_started",
  "in_progress",
  "action_required",
  "needs_reconciliation",
  "failed",
  "ready",
]);

export const lighterOnboardingNextActionSchema = z.enum([
  "start_setup",
  "continue_setup",
  "check_status",
  "none",
]);

export const lighterOnboardingChecklistSchema = z
  .object({
    deposit: lighterOnboardingStepSchema,
    key: lighterOnboardingStepSchema,
    fee: z.enum(["done", "todo", "not_required"]),
    progress: lighterOnboardingProgressSchema,
    detail: z.string().min(1).max(180),
    nextAction: lighterOnboardingNextActionSchema,
    updatedAt: z.string().datetime().nullable(),
  })
  .strict();

/**
 * The account-setup modal's read: what the modal shows before the user
 * commits (wallet balance, minimum deposit, fee terms) and what it polls
 * while a step is in flight. Address-only and pure reads; no key leaves
 * main. `settlementSymbol` and every decimal figure are already scoped to
 * `environment` (Ethereum USDC for Core, Robinhood Chain USDG for RHC).
 */
export const lighterAccountSetupStatusInputSchema = z
  .object({
    sessionId: z.string().uuid(),
    environment: lighterIntegrationEnvironmentSchema,
  })
  .strict();

export const lighterAccountSetupFeePolicySchema = z
  .object({
    perpFeePercent: z.number().positive(),
    spotFeePercent: z.number().positive(),
  })
  .strict();

export const lighterAccountSetupStatusSchema = z
  .object({
    environment: lighterIntegrationEnvironmentSchema,
    settlementSymbol: z.enum(["USDC", "USDG"]),
    /**
     * The Vex wallet the deposit is drawn from - the same address the balance
     * below is read for. Shown when the entered amount exceeds that balance,
     * so the trader knows where to send funds.
     */
    walletAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
    /** The exact wallet balance an entered amount is validated against. */
    walletSettlementBalance: unsignedDecimalStringSchema,
    /** Native gas balance is a pass/fail, not a figure the modal shows. */
    nativeGasSufficient: z.boolean(),
    /**
     * The chain the deposit settles on, named in full. Both desks pay gas in
     * ETH, so the symbol alone is ambiguous - mainnet ETH funds nothing on
     * Robinhood Chain - and the funding notice names the network instead.
     */
    settlementNetworkName: z.string().min(1),
    nativeGasSymbol: z.literal("ETH"),
    minimumDeposit: unsignedDecimalStringSchema,
    accountExists: z.boolean(),
    /** Lighter-side collateral already on the account, before any new deposit. */
    accountCollateral: unsignedDecimalStringSchema,
    tradingKeyRegistered: z.boolean(),
    /**
     * True when a trading key is registered on-chain but its local credential
     * is not yet active - a live registration intent sits in a post-submission
     * state (`change_pub_key_submitted` / `key_verified` / `nonce_synchronized`).
     * The modal completes such a key by RECONCILING it (no funds, no new
     * signature), so it may finish that step automatically. Only ever true
     * while `tradingKeyRegistered` is false.
     */
    keyRegistrationResumable: z.boolean(),
    /** Static policy terms; null when this environment collects no VEX fee. */
    feePolicy: lighterAccountSetupFeePolicySchema.nullable(),
    /** True once no fee step remains: already authorized, or none is owed. */
    feeAuthorized: z.boolean(),
  })
  .strict();

export type LighterDeskOrderDraft = z.infer<typeof lighterDeskOrderDraftSchema>;
export type LighterDeskAction = z.infer<typeof lighterDeskActionSchema>;
export type LighterDeskPrepareInput = z.infer<typeof lighterDeskPrepareInputSchema>;
export type LighterDeskPrepareResult = z.infer<typeof lighterDeskPrepareResultSchema>;
export type LighterOnboardingChecklistInput = z.infer<typeof lighterOnboardingChecklistInputSchema>;
export type LighterOnboardingChecklist = z.infer<typeof lighterOnboardingChecklistSchema>;
export type LighterAccountSetupStatusInput = z.infer<typeof lighterAccountSetupStatusInputSchema>;
export type LighterAccountSetupFeePolicy = z.infer<typeof lighterAccountSetupFeePolicySchema>;
export type LighterAccountSetupStatus = z.infer<typeof lighterAccountSetupStatusSchema>;

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
export type LighterTradingCandleHistoryInput = z.infer<
  typeof lighterTradingCandleHistoryInputSchema
>;
export type LighterTradingCandleHistory = z.infer<
  typeof lighterTradingCandleHistorySchema
>;

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
export type LighterTradingAccountActivityEvent = z.infer<
  typeof lighterTradingAccountActivityEventSchema
>;
export type LighterTradingFillsInput = z.infer<typeof lighterTradingFillsInputSchema>;
export type LighterTradingFill = z.infer<typeof lighterTradingFillSchema>;
export type LighterTradingFills = z.infer<typeof lighterTradingFillsSchema>;
export type LighterTradingAccount = z.infer<typeof lighterTradingAccountSchema>;
export type LighterTradingAccountUnavailableReason = z.infer<
  typeof lighterTradingAccountUnavailableReasonSchema
>;
export type LighterTradingAsset = z.infer<typeof lighterTradingAssetSchema>;
export type LighterTradingPosition = z.infer<typeof lighterTradingPositionSchema>;
export type LighterTradingMarginTerm = z.infer<typeof lighterTradingMarginTermSchema>;
export type LighterTradingOpenOrder = z.infer<
  typeof lighterTradingOpenOrderSchema
>;
