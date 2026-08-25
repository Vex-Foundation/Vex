/**
 * Row vocabulary and shared clauses owned by the DEEP-DIVE family: pair
 * details, candles, trades and top traders.
 *
 * Its own module rather than a share of `./screen-params/`. Those constants
 * describe pair ROWS on a channel with a drifting provider count and 100-row
 * offset pages; these four tools each read a different channel with different
 * bounds, and three of them are keyed by facts (`ammId`, the pair's own quote
 * token) the screening family never touches. The one thing they genuinely
 * share is the walk vocabulary, which lives here once.
 *
 * The wire-level bounds are re-exported from the endpoint modules rather than
 * restated, so a measured provider limit has exactly one home and a manifest
 * cannot drift away from the client that enforces it.
 */

import {
  BARS_DEADLINE_MS_CEILING,
  BARS_DEADLINE_MS_DEFAULT,
  BARS_MAX_PAGES_DEFAULT,
  BARS_PER_CALL,
  BAR_RESOLUTIONS,
} from "@tools/dexscreener/endpoints/bars.js";
import { TRADE_EVENT_TYPES, TRADES_PER_PAGE } from "@tools/dexscreener/endpoints/trades.js";
import {
  TOP_TRADERS_PROVIDER_WINDOW,
  TOP_TRADER_SORTS,
} from "@tools/dexscreener/endpoints/top-traders.js";

export {
  BARS_DEADLINE_MS_CEILING,
  BARS_DEADLINE_MS_DEFAULT,
  BARS_MAX_PAGES_DEFAULT,
  BARS_PER_CALL,
  BAR_RESOLUTIONS,
  TRADES_PER_PAGE,
  TRADE_EVENT_TYPES,
  TOP_TRADERS_PROVIDER_WINDOW,
  TOP_TRADER_SORTS,
};

/* ------------------------------------------------------------------ */
/* Tool 10: pair details                                               */
/* ------------------------------------------------------------------ */

/** Field GROUPS a pair-details report may carry. `security` and `subject` are always on. */
export const DETAILS_FIELD_GROUPS = [
  "security",
  "holders",
  "liquidityLocks",
  "supply",
  "profile",
  "listings",
  "venues",
  "suspiciousFunctionSource",
] as const;

export type DetailsFieldGroup = (typeof DETAILS_FIELD_GROUPS)[number];

/** What ships when the caller says nothing. */
export const DETAILS_FIELD_GROUPS_DEFAULT: readonly DetailsFieldGroup[] = [
  "security",
  "holders",
  "liquidityLocks",
  "supply",
];

/* ------------------------------------------------------------------ */
/* Tool 11: candles                                                    */
/* ------------------------------------------------------------------ */

/** Field GROUPS a candle answer may carry. `ohlc` is always included. */
export const CANDLE_FIELD_GROUPS = ["ohlc", "volume", "blockRange"] as const;

export type CandleFieldGroup = (typeof CANDLE_FIELD_GROUPS)[number];

export const CANDLE_FIELD_GROUPS_DEFAULT: readonly CandleFieldGroup[] = ["ohlc"];

/** Which price basis the columns carry. */
export const CANDLE_PRICE_BASES = ["usd", "native", "both"] as const;

export type CandlePriceBasis = (typeof CANDLE_PRICE_BASES)[number];

/** Price series or market-cap series. Market cap needs no supply argument. */
export const CANDLE_SERIES = ["price", "marketCap"] as const;

export type CandleSeries = (typeof CANDLE_SERIES)[number];

/**
 * Row bounds.
 *
 * The maximum is the PROVIDER's own page size, not a Vex invention (owner
 * decision D-DS5). The default is modest for context hygiene: 999 hourly bars
 * decode to 271 KB of raw provider bytes.
 */
export const CANDLE_LIMIT_MIN = 1;
export const CANDLE_LIMIT_MAX = BARS_PER_CALL;
export const CANDLE_LIMIT_DEFAULT = 100;

/* ------------------------------------------------------------------ */
/* Tool 12: trades                                                     */
/* ------------------------------------------------------------------ */

/** What shape the answer takes. All three come from ONE fetch set. */
export const TRADE_MODES = ["raw", "aggregate", "both"] as const;

export type TradeMode = (typeof TRADE_MODES)[number];

/** How much of the counterparty profile each row carries. */
export const TRADER_PROFILE_DEPTHS = ["compact", "full", "none"] as const;

export type TraderProfileDepth = (typeof TRADER_PROFILE_DEPTHS)[number];

export const TRADE_LIMIT_MIN = 1;
export const TRADE_LIMIT_MAX = TRADES_PER_PAGE;
export const TRADE_LIMIT_DEFAULT = 25;

/**
 * USD buckets the aggregate size histogram counts into.
 *
 * Fixed and stated rather than derived from the data: a histogram whose
 * buckets move with the sample cannot be compared between two calls, and
 * comparing two calls is the main thing an agent does with it.
 */
export const TRADE_SIZE_BUCKETS_USD: readonly number[] = [
  100, 1_000, 10_000, 100_000,
];

/** How many of the largest trades the aggregate block names. */
export const TRADE_LARGEST_COUNT = 5;

/* ------------------------------------------------------------------ */
/* Tool 13: top traders                                                */
/* ------------------------------------------------------------------ */

export const TOP_TRADER_LIMIT_MIN = 1;
export const TOP_TRADER_LIMIT_MAX = TOP_TRADERS_PROVIDER_WINDOW;
export const TOP_TRADER_LIMIT_DEFAULT = 25;

/* ------------------------------------------------------------------ */
/* Shared clauses                                                      */
/* ------------------------------------------------------------------ */

/**
 * The one sentence every trader-facing field on this surface inherits.
 *
 * It exists because three provider field names are wrong about what they
 * measure, and repeating a wrong name to the model on every call is how a
 * measurement becomes a false claim (rule 90).
 */
export const TRADER_SEMANTICS_CLAUSE =
  "Trader figures are venue-local and are NOT profit. netCashFlowUsd is dollars out minus "
  + "dollars in on this pair; cost basis, transfers and every other venue are invisible here, so "
  + "it cannot establish gain, loss, or whether a wallet exited. retainedBoughtPct is the share of "
  + "what the wallet BOUGHT on this pair that it still holds, never a share of token supply. "
  + "newOnPair means new on THIS pair, not a newly created wallet. An active trading span is the "
  + "time between a wallet's first and last trade here, not a holding period.";

/** How the pair identity is established, on all three pair-keyed tools. */
export const DEEP_DIVE_SUBJECT_CLAUSE =
  "Give chain plus pairAddress for a known pool, or tokenAddress to resolve the deepest pool of "
  + "the provider's bounded 30-row search window; resolutionBasis echoes which happened and a "
  + "token resolution is never a claim about every pool the token trades in. The pool's AMM id "
  + "and its quote token are resolved from the pair itself and are not parameters: a wrong AMM id "
  + "answers with zero rows and a wrong quote token returns a silently INVERTED price series, so "
  + "neither is left to the caller.";

/** The bound-reporting contract shared by the candle walk and the trade aggregate. */
export const WALK_BOUNDS_CLAUSE =
  `Deep reads walk the provider's pages under two bounds you can raise: maxPages (default `
  + `${BARS_MAX_PAGES_DEFAULT}) and deadlineMs (default ${BARS_DEADLINE_MS_DEFAULT}, ceiling `
  + `${BARS_DEADLINE_MS_CEILING}). Hitting either is REPORTED with the exact range that was `
  + "covered and a cursor for the rest, so nothing is dropped silently and everything not "
  + "returned is reachable by asking again.";
