/**
 * Solana/Jupiter prediction-market projector + money conversion (W1-B).
 *
 * Extracted from `handlers/predict.ts` — mirrors the `core.ts` → `projectors.ts`
 * / `lend.ts` → `lend-projector.ts` split already used by the sibling
 * token/lend domains in this package.
 *
 * Two responsibilities:
 *  1. `toPredictView` — the P1-11 compact-JSON projector. Events/positions
 *     carry heavy, agent-irrelevant payload (imageUrl / rulesPdf blobs,
 *     marketResultPubkey account addresses, event/market metadata noise); this
 *     curates each down to the fields the agent reasons over.
 *  2. Money conversion (W1-B). Every USD-denominated field this domain
 *     returns arrives at 1,000,000 native units = $1.00 ("micro-USD"), per
 *     developers.jup.ag/docs/prediction's "Numeric-format hazard" note
 *     (recon-docs-prediction.md §2: "All USD-denominated fields are 'micro
 *     USD' strings ... never parseFloat/Number") — confirmed live for the
 *     market pricing fields (see `JupiterPredictionUnits.md`). Before this
 *     card, every money field the projector kept was passed through RAW: an
 *     agent reading `volumeUsd: "26003599000000"` would reasonably believe
 *     that was $26 trillion, not ~$26M. Every money field below now becomes
 *     an exact-decimal dollar string plus a `<field>Micro` sibling carrying
 *     the untouched raw magnitude — both agent-visible, per the owner's
 *     money convention. All conversion is pure base-10 digit-string
 *     shifting (no BigInt division, no parseFloat) so the on-chain
 *     u64/u128/i128 magnitudes the docs warn about never lose precision.
 *
 * NOT advertised as guaranteed output (verified against manifest + discovery):
 * imageUrl, rulesPdf, marketResultPubkey, event metadata.{slug,series,closeTime,imageUrl}.
 * An event's `markets` array is opt-in (W1-C, default false) — see
 * `PredictViewOptions.includeMarkets` below.
 */

import { jupiterPredictionCloseTimeToIso } from "@tools/solana-ecosystem/jupiter/jupiter-prediction/prediction-api/close-time.js";
import type {
  JupiterPredictionHistoryEvent,
  JupiterPredictionLeaderboardEntry,
  JupiterPredictionLeaderboardSummaryPeriod,
  JupiterPredictionLeaderboardsResponse,
  JupiterPredictionOrder,
  JupiterPredictionPnlHistoryPoint,
  JupiterPredictionProfileResponse,
  JupiterPredictionTrade,
} from "@tools/solana-ecosystem/jupiter/jupiter-prediction/prediction-api/types.js";

// ── Structural helpers ────────────────────────────────────────────

/** Narrow an unknown to a plain object (excludes null + arrays). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Keep only the listed keys that are actually present on the source object. */
function pick(
  source: Record<string, unknown>,
  keys: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    if (key in source) out[key] = source[key];
  }
  return out;
}

// ── Money conversion (exact-decimal USD string + raw *Micro sibling) ──

/** 1,000,000 native units = $1.00 (6 implied decimals) — see file header. */
const MICRO_USD_DECIMALS = 6;

/** Strip a leading run of zeros that isn't the whole (single-digit) string. */
function stripLeadingZeros(digits: string): string {
  return digits.replace(/^0+(?=\d)/, "");
}

/**
 * Narrow an `unknown` field to the shape the money helpers below accept.
 * `null`/`undefined` pass through; anything that isn't a string or number
 * degrades to `undefined` so a genuinely malformed provider field can never
 * be silently coerced into a fabricated amount.
 */
function asMoneyInput(value: unknown): string | number | null | undefined {
  if (value === null || value === undefined) return value;
  return typeof value === "string" || typeof value === "number" ? value : undefined;
}

/**
 * Convert an exact micro-USD integer (string OR number wire representation;
 * `null`/`undefined` pass through as `null`) to an exact decimal dollar
 * string via pure digit-string shifting. Returns `null` for a malformed
 * (non-integer) input so a corrupt upstream value degrades to "unknown"
 * rather than fabricating a dollar amount.
 */
export function microUsdToDollarString(raw: string | number | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const digits = typeof raw === "number" ? String(raw) : raw;
  const match = /^(-?)(\d+)$/.exec(digits);
  if (!match) return null;
  const sign = match[1] ?? "";
  const wholeDigits = match[2];
  if (wholeDigits === undefined) return null;
  const padded = wholeDigits.padStart(MICRO_USD_DECIMALS + 1, "0");
  const wholePart = stripLeadingZeros(padded.slice(0, -MICRO_USD_DECIMALS)) || "0";
  const fractionPart = padded.slice(-MICRO_USD_DECIMALS);
  return `${sign}${wholePart}.${fractionPart}`;
}

/**
 * The untouched upstream micro-USD magnitude, always surfaced as a string
 * (never a bare JS number, so large on-chain integers never round-trip
 * through float precision). Unlike {@link microUsdToDollarString}, this never
 * validates — the whole point of the raw sibling is to preserve exactly what
 * was received, even if it turns out to be unparseable.
 */
function microUsdRawSibling(raw: string | number | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  return typeof raw === "number" ? String(raw) : raw;
}

/**
 * Convert a set of named micro-USD values (from Order/Position/History/Market
 * wire fields) to their agent-facing form: each name gets an exact dollar
 * string plus a `<name>Micro` sibling carrying the untouched raw magnitude.
 */
export function convertMicroUsdFields(
  values: Readonly<Record<string, string | number | null | undefined>>,
): Record<string, string | null> {
  const view: Record<string, string | null> = {};
  for (const [name, raw] of Object.entries(values)) {
    view[name] = microUsdToDollarString(raw);
    view[`${name}Micro`] = microUsdRawSibling(raw);
  }
  return view;
}

/**
 * `pricing.volume` (market pricing sub-object) is a SEPARATE scale from the 4
 * price fields in the same object: a fixture cross-check (see
 * `JupiterPredictionUnits.md`) shows it already arrives in whole dollars, not
 * micro-USD (it matched the parent event's micro-USD `volumeUsd` string
 * divided by 1e6 exactly). Confidence: inferred, single data point —
 * re-verify against a second live market before treating this as settled
 * fact. Only a plain string conversion happens here (never a bare JS number
 * for money, per the owner's money convention) — no synthetic `*Micro`
 * sibling is added because there is no confirmed native micro-scaled form of
 * this field to preserve; inventing one would fabricate provenance the
 * provider never actually sent.
 */
function wholeDollarToExactString(raw: number | undefined): string | null {
  if (raw === undefined) return null;
  return String(raw);
}

/**
 * Convert a market's `pricing` sub-object to its agent-facing money form.
 * Accepts `unknown` because callers reach this both from validated SDK
 * responses and from the polymorphic `toPredictView` traversal below.
 * Returns `undefined` when `pricing` itself is absent/not an object, so an
 * absent sub-object stays absent rather than becoming a bag of nulls.
 */
export function projectMarketPricing(pricing: unknown): Record<string, unknown> | undefined {
  if (!isRecord(pricing)) return undefined;
  return {
    ...convertMicroUsdFields({
      buyYesPriceUsd: asMoneyInput(pricing.buyYesPriceUsd),
      buyNoPriceUsd: asMoneyInput(pricing.buyNoPriceUsd),
      sellYesPriceUsd: asMoneyInput(pricing.sellYesPriceUsd),
      sellNoPriceUsd: asMoneyInput(pricing.sellNoPriceUsd),
    }),
    volumeUsd: wholeDollarToExactString(typeof pricing.volume === "number" ? pricing.volume : undefined),
  };
}

/**
 * The `*Usd`-suffixed money fields on a `GET /history` event (docs: "all
 * USD-denominated fields are micro-USD"), plus `realizedPnl` /
 * `realizedPnlBeforeFees` — CONFIRMED micro-USD (F2, developers.jup.ag/docs/
 * prediction/position-data: "Realized P&L in micro USD" / "Realized P&L
 * before fees in micro USD") despite carrying no `Usd` suffix themselves.
 * `transferAmountToken` is deliberately EXCLUDED and handled separately below
 * — the SAME doc page confirms it is "Token amount transferred (native token
 * units)", a DIFFERENT unit family (the transferred token's own decimals,
 * not this domain's fixed 6-decimal micro-USD scale) that this response does
 * not disclose; converting it with the micro-USD shift would fabricate a
 * wrong dollar amount.
 */
const HISTORY_MONEY_FIELDS = [
  "maxFillPriceUsd", "avgFillPriceUsd", "maxBuyPriceUsd", "minSellPriceUsd",
  "depositAmountUsd", "totalCostUsd", "feeUsd", "grossProceedsUsd",
  "netProceedsUsd", "payoutAmountUsd", "realizedPnl", "realizedPnlBeforeFees",
] as const satisfies readonly (keyof JupiterPredictionHistoryEvent)[];

/**
 * Restate a metadata object's display-only `closeTime` in ONE unambiguous
 * shape: the untouched raw wire value stays put (provenance), and
 * `closeTimeIso` carries the same instant as ISO-8601 UTC — the same
 * "converted value + raw sibling" pairing {@link convertMicroUsdFields} uses
 * for money.
 *
 * Needed because the provider serializes this field two ways (ISO string on
 * `/events*`, unix-SECONDS number on `/positions`+`/history` — see
 * `prediction-api/close-time.ts`). `GET /history` is the only projection that
 * forwards these metadata objects WHOLE, so it is the only place the
 * polymorphism can reach the agent; every other prediction projection curates
 * `closeTime` away entirely. Without this, a history row would hand the agent
 * a bare `1785283200` and leave it guessing seconds vs milliseconds.
 *
 * `null` (never a guess) when the value is absent, malformed, or scaled
 * outside the plausible-seconds window.
 */
function withCloseTimeIso(metadata: unknown): unknown {
  if (!isRecord(metadata) || !("closeTime" in metadata)) return metadata;
  return { ...metadata, closeTimeIso: jupiterPredictionCloseTimeToIso(metadata.closeTime) };
}

/**
 * Convert a `GET /history` event's money fields in place. Every other field
 * (ids, timestamps, contracts-family quantities) passes through untouched —
 * this is a money-correctness fix, not a field-set redesign, with two
 * deliberate exceptions: `transferAmountToken` is exposed under
 * `transferAmountTokenRaw` instead of its wire name (F2) — an explicit "raw,
 * native-token-unit, NOT a dollar figure" label (matching this domain's own
 * "raw sibling" vocabulary for the `*Micro` fields) so it can never be
 * mistaken for one of the dozen converted `*Usd` dollar strings surrounding
 * it in the same object (see the `HISTORY_MONEY_FIELDS` doc comment above for
 * why it is not converted) — and `eventMetadata`/`marketMetadata`, which get
 * a unit-explicit `closeTimeIso` sibling per {@link withCloseTimeIso}.
 */
export function convertPredictionHistoryEventMoney(
  event: JupiterPredictionHistoryEvent,
): Record<string, unknown> {
  const moneyValues: Record<string, string | null> = {};
  for (const field of HISTORY_MONEY_FIELDS) moneyValues[field] = event[field];
  const { transferAmountToken, ...rest } = event;
  return {
    ...rest,
    ...convertMicroUsdFields(moneyValues),
    transferAmountTokenRaw: transferAmountToken,
    eventMetadata: withCloseTimeIso(event.eventMetadata),
    marketMetadata: withCloseTimeIso(event.marketMetadata),
  };
}

// ── Compact-JSON projector (P1-11) ───────────────────────────────

/** Curate event metadata down to title/subtitle/eventId (drop slug/series/closeTime/imageUrl). */
function projectEventMetadata(metadata: unknown): Record<string, unknown> | undefined {
  if (!isRecord(metadata)) return undefined;
  return pick(metadata, ["eventId", "title", "subtitle"]);
}

/**
 * Curate market metadata, keeping title/subtitle/eventId. Used ONLY for the
 * genuinely-nested `marketMetadata` REFERENCE object embedded in Order/
 * Position/History rows — NOT for a top-level Market object, which is FLAT
 * on the wire (see `projectMarket` below).
 */
function projectMarketMetadata(metadata: unknown): Record<string, unknown> | undefined {
  if (!isRecord(metadata)) return undefined;
  return pick(metadata, ["marketId", "eventId", "title", "subtitle", "status", "result"]);
}

/**
 * Curate a single market: keep marketId/status/result/timings/title + the
 * converted pricing; drop imageUrl + marketResultPubkey.
 *
 * FIXTURE-CORRECTED (W1-A, 2026-07-23): the wire Market object is FLAT — no
 * nested `metadata` key exists at all (three independent live captures
 * confirmed this). The pre-fixture handler read `title`/`status`/`result` via
 * a `market.metadata` sub-object that is always `undefined` in production,
 * silently dropping `title` from every real market it projected. This reads
 * `title` directly at the top level instead.
 */
function projectMarket(market: unknown): unknown {
  if (!isRecord(market)) return market;
  const view = pick(market, [
    "marketId", "status", "result", "openTime", "closeTime", "resolveAt", "title",
  ]);
  const pricing = projectMarketPricing(market.pricing);
  if (pricing !== undefined) view.pricing = pricing;
  return view;
}

/**
 * Lean-markets toggle (W1-C). `includeMarkets` here is OUR client-side
 * decision of whether to keep the already-fetched markets in the
 * agent-facing view. This projector is the enforcement point for the
 * agent-facing contract regardless of what the provider returns — it never
 * fabricates a `markets` array that was not actually fetched (see
 * `projectEvent`'s `Array.isArray` guard below).
 *
 * CORRECTED (F2, see fixtures/prediction-events-search.meta.md CORRECTION):
 * the original "the provider ignores includeMarkets — three captures were
 * byte-for-byte identical" claim (W0-D, re-affirmed W1-A) was WRONG — a
 * rate-limit artifact of keyless 0.5-RPS probing. Re-verified with 4s
 * spacing: `includeMarkets=false` DOES omit markets upstream (897 B vs
 * 2361 B); omitted defaults to `true` server-side.
 *
 * TRANSPORT OPTIMIZATION (P1): `.events`/`.event` (`handlers/predict.ts`) now
 * pass the agent's actual `includeMarkets` value upstream instead of always
 * requesting `true` — the provider genuinely honors it, so a lean request no
 * longer fetches-then-discards the markets array. `.search`/`.suggestedEvents`
 * still cannot: neither the docs nor the SDK's params types expose an
 * `includeMarkets` query param on `/events/search` or `/events/suggested`
 * (LIVE-GATE FIX 1: pubkey moved from a path segment to a query param, see
 * `client/read.ts`) at all. Either way, this projector's own
 * `options.includeMarkets` filtering is unaffected by what the provider
 * actually sent — the agent-facing contract stays identical.
 */
export interface PredictViewOptions {
  /** Keep each event's nested `markets[]` in the projected view. Default false (lean). */
  includeMarkets?: boolean;
}

/** Curate a single event: keep eventId/category + converted volumeUsd + curated metadata + curated markets (when requested). */
function projectEvent(event: Record<string, unknown>, options: PredictViewOptions): Record<string, unknown> {
  const view = pick(event, ["eventId", "category"]);
  Object.assign(view, convertMicroUsdFields({ volumeUsd: asMoneyInput(event.volumeUsd) }));
  const metadata = projectEventMetadata(event.metadata);
  if (metadata !== undefined) view.metadata = metadata;
  if (options.includeMarkets && Array.isArray(event.markets)) view.markets = event.markets.map(projectMarket);
  return view;
}

/**
 * Curate a single position: keep exposure/PnL/claim fields (money converted)
 * + curated metadata; drop noise. `contractsMicro`/`contractsDecimal` are
 * preserved WHEN the wire response includes them (F2): the docs mark the
 * bare legacy `contracts` field "must not be used for accounting" — dropping
 * its exact-accounting siblings here would silently degrade every position
 * to that imprecise legacy count. Both are optional on the wire type;
 * `pick()` only keeps a key that is actually present, so an older response
 * without them produces no fabricated fields.
 */
function projectPosition(position: Record<string, unknown>): Record<string, unknown> {
  const view = pick(position, ["pubkey", "owner", "contracts", "contractsMicro", "contractsDecimal", "claimed", "eventId"]);
  Object.assign(view, convertMicroUsdFields({
    sizeUsd: asMoneyInput(position.sizeUsd),
    valueUsd: asMoneyInput(position.valueUsd),
    avgPriceUsd: asMoneyInput(position.avgPriceUsd),
    markPriceUsd: asMoneyInput(position.markPriceUsd),
    pnlUsd: asMoneyInput(position.pnlUsd),
    payoutUsd: asMoneyInput(position.payoutUsd),
  }));
  const eventMetadata = projectEventMetadata(position.eventMetadata);
  if (eventMetadata !== undefined) view.eventMetadata = eventMetadata;
  const marketMetadata = projectMarketMetadata(position.marketMetadata);
  if (marketMetadata !== undefined) view.marketMetadata = marketMetadata;
  return view;
}

// ── Orders / Trades (W1-D) ────────────────────────────────────────

/** The 5 `*Usd`-suffixed money fields on a prediction Order (docs + OpenAPI). */
const ORDER_MONEY_FIELDS = [
  "maxFillPriceUsd", "maxBuyPriceUsd", "minSellPriceUsd", "avgFillPriceUsd", "sizeUsd",
] as const satisfies readonly (keyof JupiterPredictionOrder)[];

/**
 * Curate a single prediction Order (`GET /orders`, `GET /orders/{orderPubkey}`,
 * W1-D): converts its money fields to the W1-B convention and curates the
 * nested `eventMetadata`/`marketMetadata` refs the same way `projectPosition`
 * already does, then drops `bump` (PDA seed) + `marketIdHash` — pure
 * internal-account noise with zero decision-relevant content for an agent
 * (owner rule: field projection is always allowed). This is a brand-new
 * tool's output shape — unlike `solana.predict.market` (which deliberately
 * stays raw, W1-B, to avoid narrowing an ALREADY-established agent-facing
 * contract), there is no pre-existing shape to break here, so building it on
 * the domain's established curated-projection convention is the safe
 * default, not an unrequested redesign.
 */
export function projectPredictionOrder(order: JupiterPredictionOrder): Record<string, unknown> {
  const view: Record<string, unknown> = { ...order };
  delete view.bump;
  delete view.marketIdHash;
  const moneyValues: Record<string, string | null> = {};
  for (const field of ORDER_MONEY_FIELDS) moneyValues[field] = order[field];
  Object.assign(view, convertMicroUsdFields(moneyValues));
  const eventMetadata = projectEventMetadata(order.eventMetadata);
  if (eventMetadata !== undefined) view.eventMetadata = eventMetadata;
  const marketMetadata = projectMarketMetadata(order.marketMetadata);
  if (marketMetadata !== undefined) view.marketMetadata = marketMetadata;
  return view;
}

/**
 * Convert a global trade-feed row's money fields (`GET /trades`, W1-D):
 * `amountUsd`/`priceUsd` follow the same domain-wide "all USD fields are
 * micro-USD" convention (docs §2) as every other endpoint. No field-set
 * change beyond the money conversion — every other field (ids, side, action,
 * titles, imageUrl) passes through untouched.
 */
export function projectPredictionTrade(trade: JupiterPredictionTrade): Record<string, unknown> {
  return {
    ...trade,
    ...convertMicroUsdFields({ amountUsd: trade.amountUsd, priceUsd: trade.priceUsd }),
  };
}

// ── Profile / PnL / Leaderboards (W1-F) ───────────────────────────

/** The 3 `*Usd`-suffixed money fields on a prediction trader Profile (docs + OpenAPI). */
const PROFILE_MONEY_FIELDS = [
  "realizedPnlUsd", "totalVolumeUsd", "totalPositionsValueUsd",
] as const satisfies readonly (keyof JupiterPredictionProfileResponse)[];

/**
 * Convert a trader Profile's money fields to the W1-B convention.
 * `predictionsCount`/`correctPredictions`/`wrongPredictions`/
 * `totalActiveContracts`(`Micro`/`Decimal`) pass through untouched — these are
 * quantity/count fields, not USD amounts (no `Usd` suffix), and
 * `totalActiveContracts` already carries its OWN provider-supplied
 * `*Micro`/`*Decimal` contract-quantity siblings per the docs'
 * three-parallel-representation convention — a different field family from
 * the money convention this function applies.
 */
export function projectPredictionProfile(profile: JupiterPredictionProfileResponse): Record<string, unknown> {
  const moneyValues: Record<string, string | null> = {};
  for (const field of PROFILE_MONEY_FIELDS) moneyValues[field] = profile[field];
  return { ...profile, ...convertMicroUsdFields(moneyValues) };
}

/** Convert one PnL-history data point's `realizedPnlUsd` field. */
export function projectPredictionPnlHistoryPoint(
  point: JupiterPredictionPnlHistoryPoint,
): Record<string, unknown> {
  return { ...point, ...convertMicroUsdFields({ realizedPnlUsd: point.realizedPnlUsd }) };
}

/** The 2 `*Usd`-suffixed money fields on a leaderboard row (docs + OpenAPI). */
const LEADERBOARD_ENTRY_MONEY_FIELDS = [
  "realizedPnlUsd", "totalVolumeUsd",
] as const satisfies readonly (keyof JupiterPredictionLeaderboardEntry)[];

/**
 * Convert a leaderboard row's money fields. `winRatePct` is deliberately left
 * untouched: unlike every other money field in this domain it carries no
 * confirmed micro-USD unit evidence (it's a percentage, not a USD amount, and
 * neither the docs nor a fixture clarify whether it's already a plain decimal
 * percent string or some other scaled representation) — guessing risks
 * fabricating a wrong number, the same reasoning W1-B applied to History's
 * unconfirmed `realizedPnl`/`transferAmountToken` fields. `predictionsCount`/
 * `correctPredictions`/`wrongPredictions`/`period`/`periodStart`/`periodEnd`
 * are quantity/label fields, not money — also left untouched.
 */
export function projectPredictionLeaderboardEntry(
  entry: JupiterPredictionLeaderboardEntry,
): Record<string, unknown> {
  const moneyValues: Record<string, string | null> = {};
  for (const field of LEADERBOARD_ENTRY_MONEY_FIELDS) moneyValues[field] = entry[field];
  return { ...entry, ...convertMicroUsdFields(moneyValues) };
}

/** Convert one leaderboard `summary` period bucket's `totalVolumeUsd`. */
function projectLeaderboardSummaryPeriod(
  period: JupiterPredictionLeaderboardSummaryPeriod,
): Record<string, unknown> {
  return { ...period, ...convertMicroUsdFields({ totalVolumeUsd: period.totalVolumeUsd }) };
}

/** Convert the leaderboard response's `summary.{all_time,weekly,monthly}.totalVolumeUsd`. */
export function projectPredictionLeaderboardsSummary(
  summary: JupiterPredictionLeaderboardsResponse["summary"],
): Record<string, unknown> {
  return {
    all_time: projectLeaderboardSummaryPeriod(summary.all_time),
    weekly: projectLeaderboardSummaryPeriod(summary.weekly),
    monthly: projectLeaderboardSummaryPeriod(summary.monthly),
  };
}

/**
 * Project a prediction event or position to its agent-facing view.
 * Returns the input untouched for non-object values so it is safe to map over
 * arrays of mixed/unknown shape without producing `null` holes.
 * `options.includeMarkets` only affects the event branch (positions never
 * carry a `markets` array) — see {@link PredictViewOptions}.
 */
export function toPredictView(item: unknown, options: PredictViewOptions = {}): unknown {
  if (!isRecord(item)) return item;
  // A position carries a top-level `pubkey`; an event never does.
  if (typeof item.pubkey === "string") return projectPosition(item);
  if (typeof item.eventId === "string") return projectEvent(item, options);
  return item;
}
