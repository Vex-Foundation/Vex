/**
 * The watchlist and price alert service (F01): the ONE owner of the rules.
 *
 * The `Watchlist` and `PriceAlert` engine tools and the Watchlist page's IPC
 * channels both call these functions, so the limits, the validation and the
 * refusals are identical whichever way an alert is made. Nothing here trades,
 * signs or touches a wallet: an alert only notifies.
 *
 * Refusals are values, never throws: `{ ok: false, reason, message }`, where
 * `reason` is a fixed code ({@link AlertRefusalReason}) and `message` a plain
 * sentence a tool result or the page can show as is.
 */

import { isPositiveDecimal } from "../../tools/dexscreener/token-watch-price/decimal.js";
import {
  addressShapeHint,
  isValidAddressForFamily,
  normalizeAddressForFamily,
  resolveWatchChain,
} from "../engine/wake/watch/token-price/chain-domain.js";
import * as alertRepo from "../db/repos/price-alerts.js";
import type { PriceAlertOrigin, PriceAlertRow, WatchlistItemRow } from "../db/repos/price-alerts.js";
import {
  alertLevel,
  alreadyPast,
  formatAlertDecimal,
  isPriceAlertCondition,
  parseAlertValue,
  type PriceAlertCondition,
} from "./condition.js";
import {
  assetKeyOf,
  priceTokens as readPrices,
  type PriceAsset,
  type PriceTokensOptions,
  type PriceTokensResult,
  type TokenQuote,
} from "./price-source.js";

/** How many tokens may be followed, and how many alerts may wait at once. */
export const WATCHLIST_LIMIT = 30;
export const ACTIVE_ALERT_LIMIT = 20;
export const NOTE_MAX_CHARS = 140;
export const LABEL_MAX_CHARS = 80;
/** Fired alerts the snapshot carries, newest first. */
export const FIRED_LIST_LIMIT = 50;

export const ALERT_REFUSAL_REASONS = [
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
] as const;
export type AlertRefusalReason = (typeof ALERT_REFUSAL_REASONS)[number];

export interface AlertRefusal {
  readonly ok: false;
  readonly reason: AlertRefusalReason;
  readonly message: string;
}

export type PriceAlertView = PriceAlertRow;

export interface WatchlistQuoteView {
  readonly priceUsd: string;
  /** Percent over 24 hours, or `null` when the pool cannot say it for this token. */
  readonly change24hPct: number | null;
  readonly pairAddress: string;
  readonly dexId: string;
}

export type WatchlistPriceStatus = "priced" | "no_price" | "unavailable";

export interface WatchlistItemView {
  readonly assetKey: string;
  readonly chain: string;
  readonly address: string;
  readonly label: string;
  readonly createdAt: string;
  readonly quote: WatchlistQuoteView | null;
  /** `no_price`: no pool we act on; `unavailable`: the read failed this time. */
  readonly priceStatus: WatchlistPriceStatus;
}

export interface WatchlistSnapshot {
  readonly items: readonly WatchlistItemView[];
  readonly activeAlerts: readonly PriceAlertView[];
  readonly firedAlerts: readonly PriceAlertView[];
  readonly limits: { readonly watchlist: number; readonly activeAlerts: number };
  /** When the prices in `items` were read. */
  readonly pricedAt: string;
}

export interface AlertServiceDeps {
  readonly repo: Pick<
    typeof alertRepo,
    | "listWatchlist"
    | "addWatchlistItem"
    | "removeWatchlistItem"
    | "listAlerts"
    | "createAlert"
    | "cancelAlert"
    | "acknowledgeFired"
    | "clearFired"
  >;
  readonly priceTokens: (assets: readonly PriceAsset[], options?: PriceTokensOptions) => Promise<PriceTokensResult>;
  readonly now: () => Date;
}

const DEFAULT_DEPS: AlertServiceDeps = { repo: alertRepo, priceTokens: readPrices, now: () => new Date() };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function refuse(reason: AlertRefusalReason, message: string): AlertRefusal {
  return { ok: false, reason, message };
}

const CHAIN_NOTE =
  "Alerts and the watchlist cover the EVM chains Vex swaps on (ethereum, base, arbitrum, bsc and the rest) and solana.";

interface ResolvedAsset extends PriceAsset {
  readonly assetKey: string;
}

function resolveAsset(chain: string, tokenAddress: string): ResolvedAsset | AlertRefusal {
  const resolved = resolveWatchChain(chain);
  if (resolved === null) {
    return refuse("unsupported_chain", `"${chain.slice(0, 40)}" is not a supported chain. ${CHAIN_NOTE}`);
  }
  const trimmed = tokenAddress.trim();
  if (!isValidAddressForFamily(resolved.family, trimmed)) {
    return refuse("invalid_address", `That is not a token address for ${resolved.slug}: ${addressShapeHint(resolved.family)}.`);
  }
  const address = normalizeAddressForFamily(resolved.family, trimmed);
  const asset = { chain: resolved.slug, address };
  return { ...asset, assetKey: assetKeyOf(asset) };
}

function isRefusal(value: unknown): value is AlertRefusal {
  return typeof value === "object" && value !== null && "ok" in value && value.ok === false;
}

function shortAddress(address: string): string {
  return address.length <= 12 ? address : `${address.slice(0, 6)}...${address.slice(-4)}`;
}

/** The user's own label, trimmed, or `null` when none was given. */
function ownLabel(raw: string | undefined): string | null | AlertRefusal {
  if (raw === undefined) return null;
  const trimmed = raw.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > LABEL_MAX_CHARS) {
    return refuse("invalid_label", `A label is at most ${LABEL_MAX_CHARS} characters.`);
  }
  return trimmed;
}

function quoteView(quote: TokenQuote): WatchlistQuoteView {
  return {
    priceUsd: quote.priceUsd,
    change24hPct: quote.change24hPct,
    pairAddress: quote.pairAddress,
    dexId: quote.dexId,
  };
}

function itemView(row: WatchlistItemRow, prices: PriceTokensResult): WatchlistItemView {
  const quote = prices.quotes.get(row.assetKey);
  const status: WatchlistPriceStatus = quote !== undefined
    ? "priced"
    : prices.failed.includes(row.assetKey) ? "unavailable" : "no_price";
  return {
    assetKey: row.assetKey,
    chain: row.chain,
    address: row.address,
    label: row.label,
    createdAt: row.createdAt,
    quote: quote === undefined ? null : quoteView(quote),
    priceStatus: status,
  };
}

// ── Reads ───────────────────────────────────────────────────────────

export interface ReadWatchlistOptions {
  readonly signal?: AbortSignal;
  readonly firedLimit?: number;
}

/** Followed tokens with live prices, active alerts, recent fired alerts and the limits. */
export async function readWatchlist(
  options: ReadWatchlistOptions = {},
  deps: AlertServiceDeps = DEFAULT_DEPS,
): Promise<WatchlistSnapshot> {
  const [items, activeAlerts, firedAlerts] = await Promise.all([
    deps.repo.listWatchlist(),
    deps.repo.listAlerts({ status: "active", limit: ACTIVE_ALERT_LIMIT }),
    deps.repo.listAlerts({ status: "triggered", limit: options.firedLimit ?? FIRED_LIST_LIMIT }),
  ]);
  const prices = await deps.priceTokens(
    items.map((item) => ({ chain: item.chain, address: item.address })),
    options.signal === undefined ? {} : { signal: options.signal },
  );
  return {
    items: items.map((item) => itemView(item, prices)),
    activeAlerts,
    firedAlerts,
    limits: { watchlist: WATCHLIST_LIMIT, activeAlerts: ACTIVE_ALERT_LIMIT },
    pricedAt: deps.now().toISOString(),
  };
}

// ── Watchlist edits ─────────────────────────────────────────────────

export interface AddToWatchlistInput {
  readonly chain: string;
  readonly tokenAddress: string;
  readonly label?: string;
}

export type AddToWatchlistResult =
  | { readonly ok: true; readonly item: WatchlistItemView; readonly created: boolean }
  | AlertRefusal;

/**
 * Follow a token. The label is the user's own words, else the pool's symbol,
 * else a short address. Following a token again returns it (`created: false`).
 */
export async function addToWatchlist(
  input: AddToWatchlistInput,
  deps: AlertServiceDeps = DEFAULT_DEPS,
): Promise<AddToWatchlistResult> {
  const asset = resolveAsset(input.chain, input.tokenAddress);
  if (isRefusal(asset)) return asset;
  const label = ownLabel(input.label);
  if (isRefusal(label)) return label;

  const prices = await deps.priceTokens([asset]);
  const quote = prices.quotes.get(asset.assetKey);
  const added = await deps.repo.addWatchlistItem(
    {
      chain: asset.chain,
      address: asset.address,
      assetKey: asset.assetKey,
      label: label ?? quote?.symbol ?? shortAddress(asset.address),
    },
    WATCHLIST_LIMIT,
  );
  if (!added.ok) {
    return refuse("watchlist_full", `The watchlist holds at most ${WATCHLIST_LIMIT} tokens. Remove one first.`);
  }
  return { ok: true, item: itemView(added.item, prices), created: added.created };
}

export type RemoveFromWatchlistResult = { readonly ok: true; readonly assetKey: string } | AlertRefusal;

export async function removeFromWatchlist(
  input: { readonly assetKey: string },
  deps: AlertServiceDeps = DEFAULT_DEPS,
): Promise<RemoveFromWatchlistResult> {
  const removed = await deps.repo.removeWatchlistItem(input.assetKey);
  return removed
    ? { ok: true, assetKey: input.assetKey }
    : refuse("not_found", "That token is not on the watchlist.");
}

// ── Alerts ──────────────────────────────────────────────────────────

export interface SetPriceAlertInput {
  readonly chain: string;
  readonly tokenAddress: string;
  readonly condition: PriceAlertCondition;
  /** A USD price for above/below, a percent for rises_pct/falls_pct. */
  readonly value: string;
  readonly note?: string;
  readonly label?: string;
  readonly origin: PriceAlertOrigin;
  readonly sessionId?: string | null;
}

export type SetPriceAlertResult =
  | {
      readonly ok: true;
      /** `already_set`: the same alert was already waiting and is returned. */
      readonly status: "created" | "already_set";
      readonly alert: PriceAlertView;
      /** The price read when the alert was set (or confirmed). */
      readonly priceUsd: string;
    }
  | AlertRefusal;

const VALUE_RULE =
  "The value is a plain positive number: a USD price for above/below, or a percent for rises_pct (at most 1000) and falls_pct (below 100).";

/**
 * Set an alert that notifies once. Reads the price once: `no_price` when
 * there is none, `already_past` when a level alert would fire at once.
 */
export async function setPriceAlert(
  input: SetPriceAlertInput,
  deps: AlertServiceDeps = DEFAULT_DEPS,
): Promise<SetPriceAlertResult> {
  const asset = resolveAsset(input.chain, input.tokenAddress);
  if (isRefusal(asset)) return asset;
  if (!isPriceAlertCondition(input.condition)) {
    return refuse("invalid_value", "The condition is one of above, below, rises_pct or falls_pct.");
  }
  const value = parseAlertValue(input.condition, input.value);
  if (value === null) return refuse("invalid_value", VALUE_RULE);
  const note = input.note?.trim() ?? "";
  if (note.length > NOTE_MAX_CHARS) {
    return refuse("invalid_note", `A note is at most ${NOTE_MAX_CHARS} characters.`);
  }
  const label = ownLabel(input.label);
  if (isRefusal(label)) return label;

  const prices = await deps.priceTokens([asset]);
  const quote = prices.quotes.get(asset.assetKey);
  if (quote === undefined || !isPositiveDecimal(quote.price)) {
    return refuse(
      "no_price",
      prices.failed.includes(asset.assetKey)
        ? "The price could not be read just now. Try again in a moment."
        : `No DEX pool prices this token on ${asset.chain}, so there is nothing to alert on. Check the address and chain.`,
    );
  }
  if (alreadyPast(input.condition, value, quote.price)) {
    return refuse(
      "already_past",
      `The price is already ${input.condition} ${formatAlertDecimal(value)}: it is ${quote.priceUsd} USD now.`,
    );
  }
  const level = alertLevel(input.condition, value, quote.price);
  if (level === null) return refuse("invalid_value", VALUE_RULE);

  const created = await deps.repo.createAlert(
    {
      chain: asset.chain,
      address: asset.address,
      assetKey: asset.assetKey,
      label: label ?? quote.symbol ?? shortAddress(asset.address),
      condition: input.condition,
      value: formatAlertDecimal(value),
      referencePrice: quote.priceUsd,
      triggerPrice: formatAlertDecimal(level.triggerPrice),
      direction: level.direction,
      note: note.length === 0 ? null : note,
      origin: input.origin,
      sessionId: input.sessionId ?? null,
    },
    ACTIVE_ALERT_LIMIT,
  );
  if (!created.ok) {
    return refuse("too_many_alerts", `At most ${ACTIVE_ALERT_LIMIT} alerts can wait at once. Cancel one first.`);
  }
  return {
    ok: true,
    status: created.created ? "created" : "already_set",
    alert: created.alert,
    priceUsd: quote.priceUsd,
  };
}

export type CancelPriceAlertResult = { readonly ok: true; readonly alert: PriceAlertView } | AlertRefusal;

/** Cancel a waiting alert. A fired, cancelled or unknown id is `not_found`. */
export async function cancelPriceAlert(
  input: { readonly alertId: string },
  deps: AlertServiceDeps = DEFAULT_DEPS,
): Promise<CancelPriceAlertResult> {
  const id = input.alertId.trim();
  if (!UUID_PATTERN.test(id)) return refuse("not_found", "No waiting alert has that id.");
  const cancelled = await deps.repo.cancelAlert(id);
  return cancelled === null
    ? refuse("not_found", "No waiting alert has that id.")
    : { ok: true, alert: cancelled };
}

export interface AcknowledgeFiredInput {
  readonly alertIds: readonly string[];
  /** `true` also removes them from the Fired list. */
  readonly clear: boolean;
}

/** Mark fired alerts seen (the user closed the notice), and optionally clear them. */
export async function acknowledgeFired(
  input: AcknowledgeFiredInput,
  deps: AlertServiceDeps = DEFAULT_DEPS,
): Promise<{ readonly ok: true; readonly acknowledged: number; readonly cleared: number }> {
  const ids = input.alertIds.map((id) => id.trim()).filter((id) => UUID_PATTERN.test(id));
  const acknowledged = await deps.repo.acknowledgeFired(ids);
  const cleared = input.clear ? await deps.repo.clearFired(ids) : 0;
  return { ok: true, acknowledged, cleared };
}
