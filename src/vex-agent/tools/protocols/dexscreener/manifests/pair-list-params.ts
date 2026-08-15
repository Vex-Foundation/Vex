/**
 * The shared param vocabulary for every DexScreener pair-list tool.
 *
 * Declared once and spread into each manifest, so `minTurnoverRatio` cannot mean
 * one thing on `search` and another on `tokenPairs`, and so the honest sentence
 * each param must carry is written in exactly one place.
 *
 * THE ONE SENTENCE EVERY PARAM HERE INHERITS
 *
 * DexScreener offers no server-side filter, sort, limit or pagination — the whole
 * API has one query parameter. Proven three ways on the live endpoint: the same
 * `search` query with and without `chainIds`/`limit`/`sort`/`order`/`page`/
 * `minLiquidity` appended returned the identical 30-pair set. So every param
 * below subtracts from, orders, or narrows at most 30 rows DexScreener already
 * chose, and an empty result never means "this does not exist".
 *
 * Handler defaults are echoed in `filtersApplied.limit`; `hasMore` and `offset`
 * expose the rest of the same provider window.
 *
 * This file is the public entry point and owns the per-TOOL compositions; the
 * vocabulary itself lives in `./pair-list-params/` (0R.16 facade split,
 * refactor-only): `clauses.ts` (the inherited sentences), `shaping.ts` (window,
 * projection, sort, timeframe, drop diagnostics), `filters.ts` (venue,
 * threshold, age, quality, and the search-only chain filter).
 */

import type { ProtocolParamDef } from "../../types.js";
import {
  EXPLAIN_DROPS_PARAM,
  PAIR_SORT_PARAMS,
  PAIR_TIMEFRAME_PARAMS,
  PAIR_WINDOW_PARAMS,
} from "./pair-list-params/shaping.js";
import {
  PAIR_AGE_FILTER_PARAMS,
  PAIR_QUALITY_FILTER_PARAMS,
  PAIR_THRESHOLD_FILTER_PARAMS,
  PAIR_VENUE_FILTER_PARAMS,
} from "./pair-list-params/filters.js";

export {
  PAIR_DESCRIPTION_WINDOW_CLAUSE,
  STRING_OR_ARRAY_CLAUSE,
  WINDOW_CLAUSE,
} from "./pair-list-params/clauses.js";
export {
  EXPLAIN_DROPS_PARAM,
  PAIR_OMIT_FIELDS_PARAM,
  PAIR_SORT_PARAMS,
  PAIR_TIMEFRAME_PARAMS,
  PAIR_WINDOW_PARAMS,
} from "./pair-list-params/shaping.js";
export {
  PAIR_AGE_FILTER_PARAMS,
  PAIR_QUALITY_FILTER_PARAMS,
  PAIR_THRESHOLD_FILTER_PARAMS,
  PAIR_VENUE_FILTER_PARAMS,
  SEARCH_CHAIN_FILTER_PARAM,
} from "./pair-list-params/filters.js";

/**
 * The whole shared vocabulary, in the order an agent reads it.
 *
 * `chainIds` is NOT here: it only means something where the provider mixed chains
 * into one window, which is `dexscreener.search` alone. On the other three tools
 * every row is already on the `chain` the caller supplied.
 */
export const PAIR_LIST_PARAMS: readonly ProtocolParamDef[] = [
  ...PAIR_WINDOW_PARAMS,
  ...PAIR_SORT_PARAMS,
  ...PAIR_TIMEFRAME_PARAMS,
  ...PAIR_VENUE_FILTER_PARAMS,
  ...PAIR_THRESHOLD_FILTER_PARAMS,
  ...PAIR_AGE_FILTER_PARAMS,
  ...PAIR_QUALITY_FILTER_PARAMS,
  EXPLAIN_DROPS_PARAM,
];

/**
 * `dexscreener.pairs` — stats for pools the caller already named.
 *
 * The pipeline accepts the whole vocabulary here too, but only these are worth
 * ADVERTISING: the response is the pools you asked for, so there is nothing for a
 * liquidity floor, a venue filter or a sort to discriminate between. Declaring
 * `minBuySellRatio` on a one-row answer would be a filter that can only ever
 * return the row or nothing.
 *
 * `explainDrops` and `omitFields` are absent for the same reason: nothing here
 * drops a row, and nothing here is omittable. Both are still REFUSED with their
 * reason by the shared parser if a caller sends one anyway.
 */
export const PAIR_LOOKUP_PARAMS: readonly ProtocolParamDef[] = [
  ...PAIR_WINDOW_PARAMS.filter((param) => param.key === "fields"),
  ...PAIR_TIMEFRAME_PARAMS,
];

/**
 * A measured bare-call size, appended to `limit` on the surface it was measured on.
 *
 * CANONICAL SOURCE: `agents_dm/agentscan-phase4/persona-tests/call-records.json`,
 * the replay that measures what the ENGINE measures
 * (`Buffer.byteLength(result.output, "utf8")`) —
 * not the persona scripts' whole-ToolResult count, which was ~2x inflated.
 *
 * Only these two pair surfaces exceeded the 16,384 B cap bare, so only these two
 * carry a number. Copying a figure onto a tool it was not measured on would be
 * the same class of error as asserting a provider cap nobody observed.
 */
function withBareCallByteCost(
  params: readonly ProtocolParamDef[],
  measured: string,
): ProtocolParamDef[] {
  return params.map((param) =>
    param.key === "limit" ? { ...param, description: `${param.description} ${measured}` } : param,
  );
}

function paramsNamed(...keys: readonly string[]): ProtocolParamDef[] {
  const wanted = new Set(keys);
  return PAIR_LIST_PARAMS.filter((param) => wanted.has(param.key));
}

/**
 * `dexscreener.search` is a resolver, not the full token-pool screener.
 *
 * Keep only output shaping plus the small set of filters that help disambiguate
 * textual/address search results. The shared parser remains intentionally wider
 * for backwards compatibility, but unsupported combinations are not taught to
 * the agent through the public manifest.
 */
export const SEARCH_LIST_PARAMS: readonly ProtocolParamDef[] = withBareCallByteCost(
  paramsNamed(
    "limit",
    "offset",
    "fields",
    "quoteSymbols",
    "minLiquidityUsd",
    "minTurnoverRatio",
    "requirePriceUsd",
    "explainDrops",
  ),
  "MEASURED: one bare pair-notation query with no limit returned 24,139 B against the 16,384 B "
    + "tool-output cap. The widest queries genuinely overflow, and `limit` is what bounds them.",
);

/**
 * `dexscreener.tokens` — one arbitrary pool per requested token address.
 *
 * Each row represents a DIFFERENT requested token's provider-chosen pool.
 * Economic filters, sorting, paging, and drop diagnostics can remove or reorder
 * holdings, so this public surface exposes snapshot shaping only. The parser
 * remains wider for backwards compatibility with existing callers.
 */
export const PAIR_BATCH_PARAMS: readonly ProtocolParamDef[] = [
  ...PAIR_WINDOW_PARAMS,
  ...PAIR_TIMEFRAME_PARAMS,
];

export const TOKENS_BATCH_PARAMS: readonly ProtocolParamDef[] = PAIR_BATCH_PARAMS;
