/**
 * The Lighter arm of the Agent Scan feed: one entry per fill from the local
 * `lighter_fills` ledger (migration 152), attributed to a Vex order intent.
 *
 * A sibling of `agent-scan-feed.ts` rather than a section of it: the feed
 * module owns the cursor, the filters, the page envelope and the
 * `agent_activity` entry, and this module owns the fill entry, which has its
 * own vocabulary (venue, market, position effect, fee provenance), its own
 * bounds and its own reasons to change (a new ledger column, a new provider
 * fact). The feed unions the two entries on `source`.
 *
 * Every rule of the feed module's header applies here unchanged: tolerant
 * bounded open strings for vocabularies, display text bounded exactly as the
 * feed bounds its own (the reader's `LEFT(...)` clamps and these `.max(...)`
 * share one table), numbers and identifiers validated by shape and NEVER
 * clamped, URLs never (a fill has none), and scope decided in main.
 */

import { z } from "zod";
import { TOKEN_SYMBOL_MAX_LENGTH } from "../token-symbol-sanitizer.js";

/**
 * Bounds for the Lighter arm's DISPLAY-ONLY text, shared with the reader's
 * SQL `LEFT(...)` clamps exactly like `AGENT_SCAN_TEXT_BOUNDS`. Amounts,
 * identifiers and the block height are NOT here: they are validated by SHAPE
 * below (a decimal is a decimal, an integer is an integer) and fail loudly
 * when malformed or overlength, never clamped into a different valid-looking
 * value.
 */
export const AGENT_SCAN_LIGHTER_TEXT_BOUNDS = {
  environment: 16,
  marketSymbol: 48,
  side: 8,
  tradeType: 32,
  positionEffect: 16,
  feeSide: 8,
  feeBasis: 32,
  feeTickSource: 16,
  marginMode: 16,
} as const;

/**
 * NUMBERS ARE VALIDATED BY SHAPE, not only by length. The fill ledger's own
 * CHECKs guarantee these shapes for its columns; the position JSONB does not,
 * and an IPC contract that accepted `"garbage"` as a size would let main's
 * mapper ship a number nobody can read. Each pattern is the ledger's own
 * (migration 152): unsigned and signed decimals, unsigned and signed integers.
 * Bounded to 64 characters, far above any venue figure.
 */
const LIGHTER_NUMBER_MAX_LENGTH = 64;
const UNSIGNED_DECIMAL_PATTERN = /^[0-9]+(\.[0-9]+)?$/;
const SIGNED_DECIMAL_PATTERN = /^-?[0-9]+(\.[0-9]+)?$/;
const UNSIGNED_INTEGER_PATTERN = /^[0-9]+$/;
const SIGNED_INTEGER_PATTERN = /^-?[0-9]+$/;

export const lighterUnsignedDecimalSchema = z
  .string()
  .max(LIGHTER_NUMBER_MAX_LENGTH)
  .regex(UNSIGNED_DECIMAL_PATTERN, "expected an unsigned decimal string");
export const lighterSignedDecimalSchema = z
  .string()
  .max(LIGHTER_NUMBER_MAX_LENGTH)
  .regex(SIGNED_DECIMAL_PATTERN, "expected a signed decimal string");
export const lighterUnsignedIntegerSchema = z
  .string()
  .max(LIGHTER_NUMBER_MAX_LENGTH)
  .regex(UNSIGNED_INTEGER_PATTERN, "expected an unsigned integer string");
export const lighterSignedIntegerSchema = z
  .string()
  .max(LIGHTER_NUMBER_MAX_LENGTH)
  .regex(SIGNED_INTEGER_PATTERN, "expected a signed integer string");

/** Vex intent ids (`lighter-exec-<uuid>`, `lighter-lifecycle-<uuid>`). */
const LIGHTER_INTENT_ID_MAX_LENGTH = 128;
/** "10.00" style leverage text from `initialMarginFractionToLeverageDisplay`. */
const LEVERAGE_DISPLAY_MAX_LENGTH = 16;

/** A venue asset on a fill: symbol and decimals only, no address (Lighter assets have none). */
export const agentScanLighterAssetSchema = z
  .object({
    symbol: z.string().max(TOKEN_SYMBOL_MAX_LENGTH),
    decimals: z.number().int().nonnegative(),
  })
  .strict();
export type AgentScanLighterAsset = z.infer<typeof agentScanLighterAssetSchema>;

/** An exact UNSIGNED amount in a venue asset: raw base units plus the asset it is denominated in. */
export const agentScanLighterAssetAmountSchema = z
  .object({
    raw: lighterUnsignedIntegerSchema,
    symbol: z.string().max(TOKEN_SYMBOL_MAX_LENGTH),
    decimals: z.number().int().nonnegative(),
  })
  .strict();
export type AgentScanLighterAssetAmount = z.infer<typeof agentScanLighterAssetAmountSchema>;

/** The same, SIGNED: the exchange reports a rebate as a negative charged amount. */
export const agentScanLighterSignedAssetAmountSchema = z
  .object({
    raw: lighterSignedIntegerSchema,
    symbol: z.string().max(TOKEN_SYMBOL_MAX_LENGTH),
    decimals: z.number().int().nonnegative(),
  })
  .strict();
export type AgentScanLighterSignedAssetAmount = z.infer<typeof agentScanLighterSignedAssetAmountSchema>;

/**
 * A leverage reading from an initial margin fraction on the provider's 10000
 * scale (1000 = 10x). `display` is produced in main by the same
 * `initialMarginFractionToLeverageDisplay` rule the Lighter leverage overview
 * uses: two decimals, TRUNCATED ("2.99" for 3334), never rounded up.
 */
export const agentScanLighterLeverageSchema = z
  .object({
    initialMarginFraction: z.number().int().min(1).max(10_000),
    display: z.string().min(1).max(LEVERAGE_DISPLAY_MAX_LENGTH),
  })
  .strict();
export type AgentScanLighterLeverage = z.infer<typeof agentScanLighterLeverageSchema>;

/**
 * The integrator (Vex) fee on a fill, with its PROVENANCE intact (migration
 * 152): `charged` is the provider's exact amount and is null until proven
 * (never zero as a placeholder); `estimate` is arithmetic on this fill's own
 * basis and names the tick it used. A renderer shows `charged` when present
 * and otherwise the estimate WITH the estimate marker; it never adds them.
 */
export const agentScanLighterIntegratorFeeSchema = z
  .object({
    charged: agentScanLighterAssetAmountSchema.nullable(),
    estimate: z
      .object({
        raw: lighterUnsignedIntegerSchema,
        symbol: z.string().max(TOKEN_SYMBOL_MAX_LENGTH),
        decimals: z.number().int().nonnegative(),
        /** `quote_notional` or `received_base`; tolerant bounded open string. */
        basis: z.string().max(AGENT_SCAN_LIGHTER_TEXT_BOUNDS.feeBasis),
        /** `observed` or `authorized`; tolerant bounded open string. */
        tickSource: z.string().max(AGENT_SCAN_LIGHTER_TEXT_BOUNDS.feeTickSource),
        /** USD estimate on the provider's own USD notional; null on a spot buy. */
        usd: lighterUnsignedDecimalSchema.nullable(),
      })
      .strict()
      .nullable(),
    /** Millionths of notional as the provider stamped them; null when absent. */
    tickObserved: z.number().int().nullable(),
    tickAuthorized: z.number().int().nullable(),
  })
  .strict();
export type AgentScanLighterIntegratorFee = z.infer<typeof agentScanLighterIntegratorFeeSchema>;

/**
 * The exchange's own tier fee. `charged` is exact when proven, denominated by
 * the SAME rule the AgentScan wire mapper applies (the received base on a spot
 * buy, the quote asset otherwise); a rebate is a negative raw amount. Else the
 * USD estimate, rendered as one.
 */
export const agentScanLighterExchangeFeeSchema = z
  .object({
    charged: agentScanLighterSignedAssetAmountSchema.nullable(),
    estimatedUsd: lighterUnsignedDecimalSchema.nullable(),
    tickObserved: z.number().int().nullable(),
  })
  .strict();
export type AgentScanLighterExchangeFee = z.infer<typeof agentScanLighterExchangeFeeSchema>;

/**
 * An open position as last observed on this fill's market. Every optional
 * fact is independently unknown: a malformed leverage or margin mode becomes
 * null WITHOUT discarding the readable size and prices beside it.
 */
export const agentScanLighterObservedPositionSchema = z
  .object({
    /** Signed decimal string in base units; negative while short. */
    size: lighterSignedDecimalSchema,
    entryPrice: lighterUnsignedDecimalSchema.nullable(),
    unrealizedPnl: lighterSignedDecimalSchema.nullable(),
    realizedPnl: lighterSignedDecimalSchema.nullable(),
    liquidationPrice: lighterUnsignedDecimalSchema.nullable(),
    /** Null on observations stored before leverage was projected, or when unreadable. */
    leverage: agentScanLighterLeverageSchema.nullable(),
    /** `cross` or `isolated`; tolerant bounded open string; null when not projected. */
    marginMode: z.string().max(AGENT_SCAN_LIGHTER_TEXT_BOUNDS.marginMode).nullable(),
  })
  .strict();
export type AgentScanLighterObservedPosition = z.infer<typeof agentScanLighterObservedPositionSchema>;

/**
 * The newest observed state of this fill's market, as CONTEXT beside a
 * historical fill. A discriminated union on `open` so that the invariant is
 * in the type, not in a comment: a market observed CLOSED has no position
 * details (migration 152 stores `open = false, position = NULL`); a market
 * observed OPEN carries its details, or `null` when the stored details could
 * not be read ("open, details unavailable"), which the renderer states as
 * such rather than hiding the observation. The entry's `positionNow` is
 * `null` only when NO observation exists for the market.
 *
 * `observedAt` is the time VEX LAST OBSERVED the market (assigned by the
 * position sweep), rendered beside every figure as "last observed", with the
 * date when it is not today: these are facts about then, not about the fill.
 */
export const agentScanLighterPositionNowSchema = z.discriminatedUnion("open", [
  z
    .object({
      observedAt: z.string().datetime({ offset: true }),
      open: z.literal(false),
      position: z.null(),
    })
    .strict(),
  z
    .object({
      observedAt: z.string().datetime({ offset: true }),
      open: z.literal(true),
      position: agentScanLighterObservedPositionSchema.nullable(),
    })
    .strict(),
]);
export type AgentScanLighterPositionNow = z.infer<typeof agentScanLighterPositionNowSchema>;

/**
 * One Lighter fill from the local `lighter_fills` ledger (migration 152): the
 * venue's own matched trade, attributed to a Vex order intent. Economics are
 * settled the moment the venue matched them, so this entry has no lifecycle
 * (`status` is always confirmed and is therefore not a field), no transaction
 * hash and no explorer link. The account's own half of the record
 * (`positionEffect`, `positionSizeBefore`, `accountPnl`) arrives whole or not
 * at all (`entryQuoteBefore` may be null on its own); all three null means the
 * observation was a public trade row and the renderer says "position facts
 * unknown", never 0.
 *
 * `createdAt` is the venue's `traded_at` (the feed time and the cursor time);
 * `observedAt` is when Vex saw it.
 */
export const agentScanLighterFillEntrySchema = z
  .object({
    source: z.literal("lighter_fill"),
    /** `lighter_fills.id` as a decimal string - also this row's cursor `sourceId`. */
    id: lighterUnsignedIntegerSchema,
    createdAt: z.string().datetime({ offset: true }),
    observedAt: z.string().datetime({ offset: true }),
    /** `core` or `rhc`; tolerant bounded open string. */
    environment: z.string().max(AGENT_SCAN_LIGHTER_TEXT_BOUNDS.environment),
    marketIndex: z.number().int().nonnegative(),
    marketSymbol: z.string().max(AGENT_SCAN_LIGHTER_TEXT_BOUNDS.marketSymbol),
    /** TRUE for a spot market (index at or above the venue's spot floor). A spot fill has no position. */
    spot: z.boolean(),
    /** `buy` or `sell`; tolerant bounded open string. */
    side: z.string().max(AGENT_SCAN_LIGHTER_TEXT_BOUNDS.side),
    /** `trade`, `liquidation`, `deleverage`, `market-settlement`; tolerant. */
    tradeType: z.string().max(AGENT_SCAN_LIGHTER_TEXT_BOUNDS.tradeType),
    /** `open`, `increase`, `reduce`, `close`, `flip`, `unknown`; tolerant; null = public row. */
    positionEffect: z.string().max(AGENT_SCAN_LIGHTER_TEXT_BOUNDS.positionEffect).nullable(),
    baseSize: lighterUnsignedDecimalSchema,
    price: lighterUnsignedDecimalSchema,
    quoteNotional: lighterUnsignedDecimalSchema,
    /** The provider's own USD notional for the fill; settled, not an estimate. */
    usdAmount: lighterUnsignedDecimalSchema,
    /** The venue's block height for the match. */
    blockHeight: lighterUnsignedIntegerSchema,
    baseAsset: agentScanLighterAssetSchema,
    quoteAsset: agentScanLighterAssetSchema,
    /** Signed; negative while short. Null on a public row. */
    positionSizeBefore: lighterSignedDecimalSchema.nullable(),
    entryQuoteBefore: lighterSignedDecimalSchema.nullable(),
    /** The provider's realized PnL for the account on this fill; "0" when nothing was realized. */
    accountPnl: lighterSignedDecimalSchema.nullable(),
    /**
     * Leverage BEFORE the fill. Null on public rows and on rows the ledger
     * holds without the fraction (written before the column existed and not
     * yet re-observed): "unknown", never a current value.
     */
    leverage: agentScanLighterLeverageSchema.nullable(),
    /** `maker` or `taker`; tolerant bounded open string. */
    feeSide: z.string().max(AGENT_SCAN_LIGHTER_TEXT_BOUNDS.feeSide),
    integratorFee: agentScanLighterIntegratorFeeSchema,
    exchangeFee: agentScanLighterExchangeFeeSchema,
    providerTradeId: lighterUnsignedIntegerSchema,
    providerOrderId: lighterUnsignedIntegerSchema.nullable(),
    intentId: z.string().min(1).max(LIGHTER_INTENT_ID_MAX_LENGTH),
    positionNow: agentScanLighterPositionNowSchema.nullable(),
  })
  .strict();
export type AgentScanLighterFillEntry = z.infer<typeof agentScanLighterFillEntrySchema>;
