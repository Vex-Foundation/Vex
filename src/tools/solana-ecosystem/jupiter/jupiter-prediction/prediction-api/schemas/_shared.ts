/**
 * Shared PRIVATE building blocks for the Jupiter Prediction API response
 * schemas (codex-002). Single-sourced here so the resource modules
 * (events / markets / orders / positions / transactions / …) reuse the exact
 * same base shapes instead of duplicating them.
 *
 * `marketSchema` / `eventSchema` / `orderSchema` / `positionSchema` are each
 * BOTH a private base (referenced by other resources) AND aliased to a
 * `jupiterPrediction*Schema` export from their resource module — the base is
 * defined ONCE here; the resource module re-exports the alias.
 *
 * Every object `.passthrough()`es unknown keys: prediction services forward the
 * raw upstream body downstream, so forward-compatible fields must survive.
 *
 * Zod gates shape only; it cannot prove a transaction is economically safe.
 * Downstream deserialize/sign checks remain authoritative for that.
 */

import { z } from "zod";
import { isBase64 } from "../../../../shared/schemas.js";
import { jupiterPredictionCloseTimeSchema } from "../close-time.js";

// ── Shared building blocks ─────────────────────────────────────────

export const paginationSchema = z
  .object({
    start: z.number(),
    end: z.number(),
    total: z.number(),
    hasNext: z.boolean(),
  })
  .passthrough();

/**
 * The `eventMetadata` / `marketMetadata` REFERENCE objects embedded in
 * Order/Position/History rows — and, for `eventMetadataSchema`, also the
 * `metadata` sub-object on an Event. Everything in both is DISPLAY-ONLY: no
 * field here is parsed, compared, or fed to money/signing logic, so the
 * tolerant-reader doctrine applies (only financially-consumed fields are
 * modeled strictly).
 *
 * LIVE-DRIFT FIX (2026-07-25): two fields below rejected the provider's own
 * response the first time the gate wallet actually held a position — until
 * then both endpoints returned an empty `data: []`, so no row was ever
 * validated. `solana.predict.positions` and `solana.predict.history` both
 * failed `provider_error` on real rows; `.position` and `.orderStatus` then
 * failed downstream for want of a pubkey to chain from. `orderSchema` embeds
 * these same two schema objects, so `.orders`/`.order` carried the identical
 * latent break (unexercised only because the wallet had no live order rows).
 */
export const eventMetadataSchema = z
  .object({
    eventId: z.string(),
    title: z.string().optional(),
    subtitle: z.string().optional(),
    slug: z.string().optional(),
    series: z.string().optional(),
    // Polymorphic across call sites — ISO-8601 string on `/events*`, unix
    // SECONDS number on `/positions` + `/history`. See `../close-time.ts`.
    closeTime: jupiterPredictionCloseTimeSchema.optional(),
    // AUDIT 2026-07-25: a missing image is `null` in this API, not an absent
    // key — 92 of 97 `imageUrl` values across the live captures are `null`.
    // `marketSchema.imageUrl` below already models that; this display-only
    // copy did not, so one image-less event would have failed the whole read
    // exactly the way `closeTime`/`result` failed above.
    imageUrl: z.string().nullable().optional(),
    isLive: z.boolean().optional(),
  })
  .passthrough();

export const marketMetadataSchema = z
  .object({
    marketId: z.string(),
    eventId: z.string().optional(),
    title: z.string().optional(),
    subtitle: z.string().optional(),
    description: z.string().optional(),
    status: z.string().optional(),
    // `null` while the market is unresolved — the normal state of every open
    // market, confirmed live. Its resolved sibling on the FLAT top-level
    // Market object (`marketSchema.result`) was already `.nullable()`; this
    // nested reference copy was missed.
    result: z.string().nullable().optional(),
    // Only the numeric form has been observed at this nested site, but it is
    // the same display-only field name in the same metadata family as
    // `eventMetadataSchema.closeTime` above, so it shares that field's
    // representation rather than re-deciding tolerance per site.
    closeTime: jupiterPredictionCloseTimeSchema.optional(),
    openTime: z.number().optional(),
    isTeamMarket: z.boolean().optional(),
    rulesPrimary: z.string().optional(),
    rulesSecondary: z.string().optional(),
  })
  .passthrough();

// UNIT HAZARD (confirmed live, see JupiterPredictionUnits.md): the 4 price
// fields are MICRO-USD-scaled numbers (1,000,000 = $1.00); `volume` is a
// separate, already-WHOLE-DOLLAR number in the same object. Do not assume a
// uniform scale across this sub-object.
const marketPricingSchema = z
  .object({
    buyYesPriceUsd: z.number().nullable().optional(),
    buyNoPriceUsd: z.number().nullable().optional(),
    sellYesPriceUsd: z.number().nullable().optional(),
    sellNoPriceUsd: z.number().nullable().optional(),
    volume: z.number().optional(),
  })
  .passthrough();

const marketOptionSchema = z.object({ label: z.string(), buyYes: z.boolean() }).passthrough();

/**
 * FIXTURE-CORRECTED SHAPE (2026-07-23): the wire Market object is FLAT — no
 * nested `metadata` key exists at this level (three independent live captures
 * confirmed this; see `types/events-markets.ts` for the full rationale).
 * Fields beyond the original core are `.optional()`: only observed on
 * `provider: "polymarket"` markets, and the API mixes providers under one
 * schema, so cross-provider presence is unconfirmed.
 */
export const marketSchema = z
  .object({
    marketId: z.string(),
    eventId: z.string().optional(),
    provider: z.string().optional(),
    title: z.string().optional(),
    status: z.string(),
    result: z.string().nullable(),
    openTime: z.number(),
    closeTime: z.number(),
    // LIVE-GATE FIX 2 (2026-07-24): confirmed live against both `/events`
    // (`includeMarkets=true`) and `/events/suggested` that `resolveAt`, when
    // set, is an ISO-8601 STRING (e.g. "2026-07-24T05:14:12.365Z"), not a
    // unix-epoch number — the provider is inconsistent (docs/older captures
    // only ever showed `null`). `openTime`/`closeTime` were re-checked across
    // 50+ live markets and stayed consistently numeric — no change to those.
    // `resolveAt` is display-only (pass-through in `predict-projector.ts`,
    // never parsed/compared), so tolerant per the doctrine rather than
    // coerced to one shape. This `marketSchema` is shared by `/events`,
    // `/events/search`, `/events/suggested`, `/events/{id}`, and
    // `/markets/{id}` — the fix applies to every one of those paths at once.
    resolveAt: z.union([z.number(), z.string()]).nullable(),
    marketResultPubkey: z.string().nullable().optional(),
    imageUrl: z.string().nullable().optional(),
    isTeamMarket: z.boolean().optional(),
    team: z.unknown().optional(),
    rulesPrimary: z.string().optional(),
    rulesSecondary: z.string().optional(),
    outcomes: z.array(z.string()).optional(),
    clobTokenIds: z.array(z.string()).optional(),
    marketOptions: z.array(marketOptionSchema).optional(),
    sportsMarketType: z.string().nullable().optional(),
    sportsLine: z.number().nullable().optional(),
    gameNumber: z.number().nullable().optional(),
    pricing: marketPricingSchema.optional(),
  })
  .passthrough();

export const eventSchema = z
  .object({
    eventId: z.string(),
    isActive: z.boolean(),
    isLive: z.boolean(),
    category: z.string(),
    subcategory: z.string(),
    tags: z.array(z.string()).optional(),
    metadata: eventMetadataSchema.optional(),
    markets: z.array(marketSchema).optional(),
    volumeUsd: z.string(),
    // Fixture-confirmed present on every observed event; kept optional pending
    // cross-provider confirmation (same caution as the Market fields above).
    volume24hr: z.string().optional(),
    closeCondition: z.string(),
    beginAt: z.string().nullable(),
    rulesPdf: z.string(),
    // Fixture-observed, always empty (`[]`) so far; item shape unconfirmed.
    sportsMarketGroups: z.array(z.unknown()).optional(),
  })
  .passthrough();

export const orderSchema = z
  .object({
    pubkey: z.string(),
    owner: z.string(),
    ownerPubkey: z.string(),
    market: z.string(),
    marketId: z.string(),
    marketIdHash: z.string(),
    eventId: z.string(),
    position: z.string(),
    status: z.string(),
    isYes: z.boolean(),
    isBuy: z.boolean(),
    createdAt: z.number(),
    updatedAt: z.number(),
    contracts: z.string(),
    contractsMicro: z.string().optional(),
    contractsDecimal: z.string().optional(),
    maxFillPriceUsd: z.string(),
    maxBuyPriceUsd: z.string().nullable(),
    minSellPriceUsd: z.string().nullable(),
    filledAt: z.number(),
    filledContracts: z.string(),
    filledContractsMicro: z.string().optional(),
    filledContractsDecimal: z.string().optional(),
    avgFillPriceUsd: z.string(),
    settled: z.boolean(),
    orderId: z.string(),
    sizeUsd: z.string(),
    eventMetadata: eventMetadataSchema,
    marketMetadata: marketMetadataSchema,
    externalOrderId: z.string(),
    bump: z.number(),
  })
  .passthrough();

export const positionSchema = z
  .object({
    pubkey: z.string(),
    owner: z.string(),
    ownerPubkey: z.string(),
    market: z.string(),
    marketId: z.string(),
    marketIdHash: z.string(),
    isYes: z.boolean(),
    contracts: z.string(),
    contractsMicro: z.string().optional(),
    contractsDecimal: z.string().optional(),
    totalCostUsd: z.string(),
    sizeUsd: z.string(),
    valueUsd: z.string().nullable(),
    avgPriceUsd: z.string(),
    markPriceUsd: z.string().nullable(),
    sellPriceUsd: z.string().nullable(),
    pnlUsd: z.string().nullable(),
    pnlUsdPercent: z.number().nullable(),
    pnlUsdAfterFees: z.string().nullable(),
    pnlUsdAfterFeesPercent: z.number().nullable(),
    openOrders: z.number(),
    feesPaidUsd: z.string(),
    realizedPnlUsd: z.number(),
    claimed: z.boolean(),
    claimedUsd: z.string(),
    openedAt: z.number(),
    updatedAt: z.number(),
    claimableAt: z.number().nullable(),
    payoutUsd: z.string(),
    bump: z.number(),
    eventId: z.string(),
    eventMetadata: eventMetadataSchema,
    marketMetadata: marketMetadataSchema,
    settlementDate: z.number().nullable(),
    claimable: z.boolean(),
  })
  .passthrough();

// ── Transaction meta & write-response shared pieces (FINANCIAL) ────

const transactionMetaSchema = z
  .object({
    blockhash: z.string(),
    lastValidBlockHeight: z.number(),
  })
  .passthrough();

/** `JupiterPredictionTxMetaFields` shape (txMeta + flat blockhash fields). */
export const txMetaFields = {
  txMeta: transactionMetaSchema.nullable().optional(),
  blockhash: z.string().optional(),
  lastValidBlockHeight: z.number().optional(),
} as const;

/**
 * A signing-bound transaction blob. Standard base64 when present, but a FALSEY
 * value (null / "") must pass: the service maps it to a domain
 * HTTP_REQUEST_FAILED ("did not return an executable transaction",
 * service.ts:79-90). Rejecting it here would shadow that domain error with
 * HTTP_RESPONSE_INVALID, hiding the real cause from callers. Unlike the swaps
 * template, the prediction wire has no `errorCode` companion, so "" is allowed
 * unconditionally rather than only-alongside-an-error-field.
 */
export const transactionBlobRefine = (t: string | null): boolean =>
  t === null || t === "" || isBase64(t);

export const transactionBlobMessage =
  "transaction must be base64 when present (falsey passes for the domain error path)";
