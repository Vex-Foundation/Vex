/**
 * Watchlist and price alert DTOs (F01): every input and output the Watchlist
 * page's IPC channels carry, and the price-alert-fired event.
 *
 * Shaped to match what the engine service returns
 * (`src/vex-agent/alerts/service.ts`); main validates both directions with
 * these schemas, so a drift between the two fails loudly at the boundary.
 *
 * Prices and levels are exact decimal TEXT, never numbers: the renderer shows
 * them as they are and never computes with them. Planned channels (added by
 * the page and IPC slice): `CH.alerts.{getWatchlist, editWatchlist,
 * setPriceAlert, cancelPriceAlert, acknowledgeFired}` and the event
 * `EV.alerts.priceAlertFired`.
 */

import { z } from "zod";

/** Literal kept in sync with the engine's `PRICE_ALERT_FIRED_EVENT_TYPE`. */
export const PRICE_ALERT_FIRED_EVENT_TYPE = "engine.alerts.price_alert_fired" as const;

export const ALERT_WATCHLIST_LIMIT = 30;
export const ALERT_ACTIVE_LIMIT = 20;
export const ALERT_NOTE_MAX_CHARS = 140;
export const ALERT_LABEL_MAX_CHARS = 80;

export const priceAlertConditionSchema = z.enum(["above", "below", "rises_pct", "falls_pct"]);
export type PriceAlertCondition = z.infer<typeof priceAlertConditionSchema>;

export const priceAlertDirectionSchema = z.enum(["above", "below"]);
export const priceAlertStatusSchema = z.enum(["active", "triggered", "cancelled"]);
export const priceAlertOriginSchema = z.enum(["chat", "app"]);

export const alertRefusalReasonSchema = z.enum([
  "unsupported_chain",
  "invalid_address",
  "invalid_value",
  "invalid_note",
  "invalid_label",
  "no_price",
  "already_past",
  "too_many_alerts",
  "watchlist_full",
  "not_found",
]);
export type AlertRefusalReason = z.infer<typeof alertRefusalReasonSchema>;

/** A plain non-negative decimal as text: what the engine stores and returns. */
const decimalText = z.string().regex(/^\d{1,40}(?:\.\d{1,40})?$/);
const isoTime = z.string().datetime({ offset: true });
const alertId = z.string().uuid();
const chainSlug = z.string().min(1).max(64);
const tokenAddress = z.string().min(1).max(128);
const assetKey = z.string().min(3).max(200);

/** A refusal: a fixed code and a sentence the page shows as is. */
export const alertRefusalSchema = z
  .object({
    ok: z.literal(false),
    reason: alertRefusalReasonSchema,
    message: z.string().min(1).max(500),
  })
  .strict();
export type AlertRefusalDto = z.infer<typeof alertRefusalSchema>;

export const priceAlertDtoSchema = z
  .object({
    id: alertId,
    chain: chainSlug,
    address: tokenAddress,
    assetKey,
    label: z.string().min(1).max(ALERT_LABEL_MAX_CHARS),
    condition: priceAlertConditionSchema,
    value: decimalText,
    referencePrice: decimalText,
    triggerPrice: decimalText,
    direction: priceAlertDirectionSchema,
    note: z.string().max(ALERT_NOTE_MAX_CHARS).nullable(),
    origin: priceAlertOriginSchema,
    sessionId: z.string().min(1).max(200).nullable(),
    status: priceAlertStatusSchema,
    triggeredAt: isoTime.nullable(),
    triggeredPrice: decimalText.nullable(),
    acknowledgedAt: isoTime.nullable(),
    createdAt: isoTime,
  })
  .strict();
export type PriceAlertDto = z.infer<typeof priceAlertDtoSchema>;

export const watchlistQuoteDtoSchema = z
  .object({
    priceUsd: decimalText,
    /** Percent over 24 hours, or `null` when the pool cannot say it for this token. */
    change24hPct: z.number().finite().nullable(),
    pairAddress: z.string().min(1).max(128),
    dexId: z.string().min(1).max(64),
  })
  .strict();

export const watchlistItemDtoSchema = z
  .object({
    assetKey,
    chain: chainSlug,
    address: tokenAddress,
    label: z.string().min(1).max(ALERT_LABEL_MAX_CHARS),
    createdAt: isoTime,
    quote: watchlistQuoteDtoSchema.nullable(),
    /** `no_price`: no pool we act on; `unavailable`: the read failed this time. */
    priceStatus: z.enum(["priced", "no_price", "unavailable"]),
  })
  .strict();
export type WatchlistItemDto = z.infer<typeof watchlistItemDtoSchema>;

// ── getWatchlist ────────────────────────────────────────────────────

export const getWatchlistInputSchema = z.object({}).strict();
export type GetWatchlistInput = z.infer<typeof getWatchlistInputSchema>;

export const watchlistSnapshotSchema = z
  .object({
    items: z.array(watchlistItemDtoSchema).max(ALERT_WATCHLIST_LIMIT),
    activeAlerts: z.array(priceAlertDtoSchema).max(ALERT_ACTIVE_LIMIT),
    firedAlerts: z.array(priceAlertDtoSchema).max(100),
    limits: z.object({ watchlist: z.number().int().positive(), activeAlerts: z.number().int().positive() }).strict(),
    pricedAt: isoTime,
  })
  .strict();
export type WatchlistSnapshotDto = z.infer<typeof watchlistSnapshotSchema>;

// ── editWatchlist ───────────────────────────────────────────────────

export const editWatchlistInputSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("add"),
      chain: z.string().trim().min(1).max(64),
      tokenAddress: z.string().trim().min(1).max(128),
      label: z.string().max(ALERT_LABEL_MAX_CHARS).optional(),
    })
    .strict(),
  z.object({ action: z.literal("remove"), assetKey }).strict(),
]);
export type EditWatchlistInput = z.infer<typeof editWatchlistInputSchema>;

export const editWatchlistResultSchema = z.union([
  z.object({ ok: z.literal(true), action: z.literal("add"), item: watchlistItemDtoSchema, created: z.boolean() }).strict(),
  z.object({ ok: z.literal(true), action: z.literal("remove"), assetKey }).strict(),
  alertRefusalSchema,
]);
export type EditWatchlistResult = z.infer<typeof editWatchlistResultSchema>;

// ── setPriceAlert ───────────────────────────────────────────────────

export const setPriceAlertInputSchema = z
  .object({
    chain: z.string().trim().min(1).max(64),
    tokenAddress: z.string().trim().min(1).max(128),
    condition: priceAlertConditionSchema,
    /** A USD price for above/below, a percent for rises_pct/falls_pct. */
    value: z.string().trim().min(1).max(40),
    note: z.string().max(ALERT_NOTE_MAX_CHARS).optional(),
    label: z.string().max(ALERT_LABEL_MAX_CHARS).optional(),
  })
  .strict();
export type SetPriceAlertInput = z.infer<typeof setPriceAlertInputSchema>;

export const setPriceAlertResultSchema = z.union([
  z
    .object({
      ok: z.literal(true),
      status: z.enum(["created", "already_set"]),
      alert: priceAlertDtoSchema,
      priceUsd: decimalText,
    })
    .strict(),
  alertRefusalSchema,
]);
export type SetPriceAlertResult = z.infer<typeof setPriceAlertResultSchema>;

// ── cancelPriceAlert ────────────────────────────────────────────────

export const cancelPriceAlertInputSchema = z.object({ alertId }).strict();
export type CancelPriceAlertInput = z.infer<typeof cancelPriceAlertInputSchema>;

export const cancelPriceAlertResultSchema = z.union([
  z.object({ ok: z.literal(true), alert: priceAlertDtoSchema }).strict(),
  alertRefusalSchema,
]);
export type CancelPriceAlertResult = z.infer<typeof cancelPriceAlertResultSchema>;

// ── acknowledgeFired ────────────────────────────────────────────────

export const acknowledgeFiredInputSchema = z
  .object({
    alertIds: z.array(alertId).min(1).max(100),
    /** `true` also removes them from the Fired list. */
    clear: z.boolean(),
  })
  .strict();
export type AcknowledgeFiredInput = z.infer<typeof acknowledgeFiredInputSchema>;

export const acknowledgeFiredResultSchema = z
  .object({
    ok: z.literal(true),
    acknowledged: z.number().int().nonnegative(),
    cleared: z.number().int().nonnegative(),
  })
  .strict();
export type AcknowledgeFiredResult = z.infer<typeof acknowledgeFiredResultSchema>;

// ── The fired event ─────────────────────────────────────────────────

export const priceAlertFiredEventSchema = z
  .object({
    type: z.literal(PRICE_ALERT_FIRED_EVENT_TYPE),
    alertId,
    assetKey,
    chain: chainSlug,
    label: z.string().min(1).max(ALERT_LABEL_MAX_CHARS),
    condition: priceAlertConditionSchema,
    value: decimalText,
    direction: priceAlertDirectionSchema,
    triggerPrice: decimalText,
    triggeredPrice: decimalText,
    triggeredAt: isoTime,
    note: z.string().max(ALERT_NOTE_MAX_CHARS).nullable(),
  })
  .strict();
export type PriceAlertFiredEventDto = z.infer<typeof priceAlertFiredEventSchema>;

// -- Token search (the add form's ticker picker) ------------------------------

/** What the add form sends: a chain from the closed set and what was typed. */
export const searchTokensInputSchema = z
  .object({
    chain: z.string().trim().min(1).max(32),
    query: z.string().trim().min(2).max(64),
  })
  .strict();
export type SearchTokensInput = z.infer<typeof searchTokensInputSchema>;

/** One token DexScreener knows on that chain, its pools summed. */
export const tokenSearchHitDtoSchema = z
  .object({
    address: z.string().min(1).max(128),
    symbol: z.string().min(1).max(32),
    name: z.string().min(1).max(80).nullable(),
    priceUsd: z.string().max(64).nullable(),
    liquidityUsd: z.number().nonnegative().nullable(),
    volume24hUsd: z.number().nonnegative().nullable(),
    poolCount: z.number().int().positive(),
    dexId: z.string().min(1).max(64),
    pairAddress: z.string().min(1).max(128),
  })
  .strict();
export type TokenSearchHitDto = z.infer<typeof tokenSearchHitDtoSchema>;

export const searchTokensResultSchema = z.union([
  z
    .object({
      ok: z.literal(true),
      chain: z.string().min(1).max(32),
      query: z.string().min(1).max(64),
      /** `chain_search` narrows on DexScreener; `public_search` filters a cross-chain window. */
      source: z.enum(["chain_search", "public_search"]),
      tokens: z.array(tokenSearchHitDtoSchema).max(12),
    })
    .strict(),
  z
    .object({
      ok: z.literal(false),
      reason: z.enum(["unsupported_chain", "invalid_query", "search_unavailable"]),
      message: z.string().min(1).max(500),
    })
    .strict(),
]);
export type SearchTokensResult = z.infer<typeof searchTokensResultSchema>;
