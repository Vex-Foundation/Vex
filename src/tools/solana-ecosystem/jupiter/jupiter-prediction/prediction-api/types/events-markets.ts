/**
 * Jupiter Prediction API — event and market types.
 */

import type {
  JupiterPredictionMarketStatus,
  JupiterPredictionPagination,
} from "./base.js";

/**
 * A display-only close timestamp as the provider actually serializes it: an
 * ISO-8601 string on the `/events*` side, a unix-SECONDS number on the
 * `/positions` + `/history` side. Both forms confirmed live (2026-07-25); see
 * `../close-time.ts` for the evidence, the unit proof, and the normaliser that
 * collapses the two into one agent-facing shape.
 */
export type JupiterPredictionCloseTime = number | string;

export interface JupiterPredictionEventMetadata {
  eventId: string;
  title?: string;
  subtitle?: string;
  slug?: string;
  series?: string;
  /** Display-only. Polymorphic — see {@link JupiterPredictionCloseTime}. */
  closeTime?: JupiterPredictionCloseTime;
  /** Display-only. `null` when the event has no image — the provider's convention here. */
  imageUrl?: string | null;
  isLive?: boolean;
}

export interface JupiterPredictionMarketMetadata {
  marketId: string;
  eventId?: string;
  title?: string;
  subtitle?: string;
  description?: string;
  status?: string;
  /**
   * The market's resolution outcome. Display-only, and legitimately `null`
   * while the market is still open — confirmed live on an open Polymarket
   * market (2026-07-25). Modeling it as a bare `string` made every
   * position/history row on an UNRESOLVED market fail schema validation.
   */
  result?: string | null;
  /** Display-only. Polymorphic — see {@link JupiterPredictionCloseTime}. */
  closeTime?: JupiterPredictionCloseTime;
  openTime?: number;
  isTeamMarket?: boolean;
  rulesPrimary?: string;
  rulesSecondary?: string;
}

/**
 * Market pricing sub-object. UNIT HAZARD (confirmed against a live recorded
 * response — see `../JupiterPredictionUnits.md`): `buyYesPriceUsd` /
 * `buyNoPriceUsd` / `sellYesPriceUsd` / `sellNoPriceUsd` are MICRO-USD-scaled
 * NUMBERS (1,000,000 = $1.00), matching the docs' blanket micro-USD claim —
 * NOT plain decimal dollars as an earlier (unverified) assumption held.
 * `volume`, by contrast, was observed as an already-WHOLE-DOLLAR number in
 * the same object (it matched the parent event's micro-USD `volumeUsd`
 * string divided by 1e6 exactly). Do not assume the whole sub-object shares
 * one scale — see the unit matrix before consuming any of these fields.
 */
export interface JupiterPredictionMarketPricing {
  buyYesPriceUsd?: number | null;
  buyNoPriceUsd?: number | null;
  sellYesPriceUsd?: number | null;
  sellNoPriceUsd?: number | null;
  volume?: number;
}

export interface JupiterPredictionMarketOption {
  label: string;
  buyYes: boolean;
}

/**
 * Per-market provider tag (distinct from the request-level
 * `JupiterPredictionProvider` filter enum — docs list a different value set
 * for this field: `polymarket`, `gx`, `bisonfi`). Only `polymarket` has been
 * observed live; kept open (`string & {}`) for forward compatibility,
 * matching the existing `JupiterPredictionMarketStatus` pattern.
 */
export type JupiterPredictionMarketProvider = "polymarket" | "gx" | "bisonfi" | (string & {});

/**
 * A prediction Market. FIXTURE-CORRECTED SHAPE (2026-07-23): earlier modeling
 * nested a `metadata` sub-object here (mirroring the Order/Position embedded
 * `marketMetadata` ref shape). Three independent live captures
 * (`/events?includeMarkets=true`, `/events/search`, `/markets/{marketId}`)
 * confirm the wire Market object is FLAT — no `metadata` key exists at this
 * level at all. `title`/`status`/`result`/etc. are direct top-level fields.
 * `JupiterPredictionMarketMetadata` stays canonical for the separate,
 * genuinely-nested `marketMetadata` REFERENCE object embedded in
 * Order/Position/History rows (a different, lighter-weight shape) — see
 * `orders-positions.ts`.
 *
 * All fields beyond the original core (`marketId`/`status`/`result`/
 * `openTime`/`closeTime`/`resolveAt`/`marketResultPubkey`/`imageUrl`) are
 * modeled as OPTIONAL: they were only ever observed on `provider: "polymarket"`
 * markets (`outcomes`/`clobTokenIds`/`marketOptions` in particular look
 * Polymarket-specific, e.g. CLOB token IDs), and the API mixes kalshi/gx/
 * bisonfi markets under the same schema per the docs — treat cross-provider
 * presence as unconfirmed rather than widening the required set on one
 * provider's evidence.
 */
export interface JupiterPredictionMarket {
  marketId: string;
  /** Present on standalone `/markets/{marketId}` lookups; may be absent when nested under its parent event. */
  eventId?: string;
  provider?: JupiterPredictionMarketProvider;
  title?: string;
  status: JupiterPredictionMarketStatus;
  result: string | null;
  openTime: number;
  closeTime: number;
  /** ISO-8601 string when set live (confirmed `GET /events`/`/events/suggested`, LIVE-GATE FIX 2) — kept `number | string`, display-only. */
  resolveAt: number | string | null;
  marketResultPubkey?: string | null;
  imageUrl?: string | null;
  isTeamMarket?: boolean;
  /** Docs: `object|null`. Only `null` observed live — kept as `unknown` until a populated team object is captured. */
  team?: unknown;
  rulesPrimary?: string;
  rulesSecondary?: string;
  outcomes?: string[];
  clobTokenIds?: string[];
  marketOptions?: JupiterPredictionMarketOption[];
  sportsMarketType?: string | null;
  sportsLine?: number | null;
  /** Not documented anywhere; only `null` observed live. Named/positioned like its `sportsLine`/`sportsMarketType` siblings, so modeled as a nullable number pending a populated example. */
  gameNumber?: number | null;
  pricing?: JupiterPredictionMarketPricing;
}

export interface JupiterPredictionEvent {
  eventId: string;
  isActive: boolean;
  isLive: boolean;
  category: string;
  subcategory: string;
  tags?: string[];
  metadata?: JupiterPredictionEventMetadata;
  markets?: JupiterPredictionMarket[];
  /** Micro-USD string (docs + fixture confirmed), all-time volume. */
  volumeUsd: string;
  /**
   * Micro-USD string, trailing-24h volume. Fixture-confirmed present on every
   * observed event; modeled as optional pending cross-provider confirmation
   * (see the `JupiterPredictionMarket` field-optionality note above).
   */
  volume24hr?: string;
  closeCondition: string;
  beginAt: string | null;
  rulesPdf: string;
  /** Fixture-observed, always empty (`[]`) so far; item shape is unconfirmed. */
  sportsMarketGroups?: unknown[];
}

export interface JupiterPredictionEventsResponse {
  data: JupiterPredictionEvent[];
  pagination: JupiterPredictionPagination;
}

export interface JupiterPredictionSearchEventsResponse {
  data: JupiterPredictionEvent[];
}

export interface JupiterPredictionSuggestedEventsResponse {
  data: JupiterPredictionEvent[];
}

export interface JupiterPredictionEventMarketsResponse {
  data: JupiterPredictionMarket[];
  pagination: JupiterPredictionPagination;
}

export type JupiterPredictionEventMarketResponse = JupiterPredictionMarket;
export type JupiterPredictionMarketResponse = JupiterPredictionMarket;
