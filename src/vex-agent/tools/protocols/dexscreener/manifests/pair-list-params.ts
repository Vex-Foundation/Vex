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
 * `search` query with and without `chainId`/`limit`/`sort`/`order`/`page`/
 * `minLiquidity` appended returned the identical 30-pair set. So every param
 * below subtracts from, orders, or narrows at most 30 rows DexScreener already
 * chose, and an empty result never means "this does not exist".
 *
 * `limit` HAS NO DEFAULT. Omitting it returns every row the provider returned.
 */

import type { ProtocolParamDef } from "../../types.js";

/** Repeated in the params that can silently mislead about coverage. */
const WINDOW_CLAUSE =
  "Applied by Vex to the at most 30 rows DexScreener returned — it cannot reach rows outside "
  + "that window.";

/**
 * Every param that accepts BOTH spellings says so, in one sentence, once.
 *
 * Shared with the feed vocabulary (`./feed-list-params.ts`) and the identity
 * params in `./core.ts` for the same reason the KEYS are shared: an agent that
 * learned the array form on `search` must not have to re-learn it on `boosts`.
 *
 * The cost of NOT saying it is measured — `call-records.json`, first record:
 * `dexscreener.profiles {chainIds: ["solana"]}` was rejected in 78 bytes while
 * `chainIds: "solana"` answered in 5,215.
 */
export const STRING_OR_ARRAY_CLAUSE =
  'Accepts either a comma-separated string ("a,b") or an array of strings (["a","b"]) — the two '
  + "are equivalent.";

/**
 * The same truth at TOOL level, for the `description` of `search` and `tokens`.
 *
 * It lives beside `WINDOW_CLAUSE` rather than in the manifest so the window fact
 * still has exactly one owner per family: a future correction cannot land on the
 * params and miss the description, or on one tool and miss its sibling. The
 * pair-lookup tools state their own narrower truth inline — `pairs` has no window
 * to disclose and `tokenPairs` is truncated by the provider before we see it.
 */
export const PAIR_DESCRIPTION_WINDOW_CLAUSE =
  "Every filter, sort and window is applied by Vex to at most 30 provider-chosen rows per call. "
  + "DexScreener offers no server-side filter, sort, limit or pagination, and there is no way to "
  + "widen the window.";

/** Window / paging. Replaces every silent default. */
export const PAIR_WINDOW_PARAMS: readonly ProtocolParamDef[] = [
  {
    key: "limit",
    type: "number",
    description:
      "Max rows to return (1-200). Omit to receive EVERY row DexScreener returned (at most 30 — "
      + "its hard cap). Set this only to spend fewer tokens; 0 is rejected because it cannot mean "
      + "both 'none' and 'all'.",
  },
  {
    key: "offset",
    type: "number",
    description:
      "Skip this many rows of the SAME provider window (default 0). It cannot reach rows beyond "
      + "DexScreener's 30 — there is no pagination.",
  },
  {
    key: "fields",
    type: "string",
    description:
      "Comma-separated extra output fields, ADDED to the default lean row (identity is never "
      + "projected away). Use 'full' for every field — that is also how to discover the names, "
      + "since a misspelled one is rejected with the complete accepted list. Opt-in covers the "
      + "market-cap and FDV figures, the reserve amounts on each side of the pool, every "
      + "individual m5/h1/h6/h24 window, the info/social flags, the DexScreener link, and the "
      + "issuer-authored display names — which are the single most expensive field in this API "
      + "(one live pool's name is 34,090 characters).",
  },
];

/**
 * The drop-diagnostics param, shared verbatim by all three families.
 *
 * One key, one sentence, one meaning — the same rule that put `limit` and
 * `chainIds` in one place. The index caveat is not decoration: an index the
 * agent believes is stable becomes a row identity it will try to reuse on the
 * next call, against a window the provider has already re-chosen.
 */
export const EXPLAIN_DROPS_PARAM: ProtocolParamDef = {
  key: "explainDrops",
  type: "boolean",
  description:
    "Also emit droppedRows[]: at most 10 rejected rows, each carrying the FIRST filter that "
    + "rejected it, that row's own value, and the threshold you passed — which answers 'missed by "
    + "0.1 or by 100x?' in the same call. droppedByFilter stays the full census; this is a sample, "
    + "and droppedRowsTruncated states whether more were dropped than shown. providerRowIndex is "
    + "the row's 0-based position in THIS response before filtering. It is deterministic inside "
    + "this answer and NOT stable across calls, since DexScreener re-chooses its window every "
    + "time. rowId carries the row's own identifier — a pool address, a listed-asset address, or a "
    + "narrative slug — and that is the value worth keeping. Off by default, and it costs nothing "
    + "when off.",
};

/**
 * The subtractive-projection param for the PAIR family, which accepts no names.
 *
 * Declared rather than omitted so the refusal can carry the reason: an agent
 * told only "unknown parameter" tries the next spelling, while one told the
 * fields are already additive stops and uses `fields`.
 */
export const PAIR_OMIT_FIELDS_PARAM: ProtocolParamDef = {
  key: "omitFields",
  type: "string",
  description:
    "Comma-separated output fields for REMOVAL. Pair rows accept NO names here, deliberately: "
    + "every issuer-authored text field beyond the two symbols is already opt-in via \"fields\", so "
    + "omitting one is the same as simply not requesting it; the symbols themselves are row "
    + "identity; and every number here is financially consumed. Shrink a pair row with \"fields\" "
    + "and \"limit\" instead. A rejection names each refused field and repeats this reason. The "
    + "parameter does real work on the feed and narrative tools, where a mandatory description CAN "
    + "be dropped.",
};

/** Sorting. */
export const PAIR_SORT_PARAMS: readonly ProtocolParamDef[] = [
  {
    key: "sortBy",
    type: "string",
    description:
      "relevance | liquidityUsd | volumeUsd | turnoverRatio | marketCapUsd | fdvUsd | "
      + "pairAgeSeconds | priceChangePct | txnCount | buySellRatio. 'relevance' means 'as "
      + "DexScreener returned' — its order is neither a ranking nor stable. Sorting cannot recover "
      + "a pool outside the 30-row window.",
  },
  {
    key: "sortDir",
    type: "string",
    description: "desc (default) or asc. Rows whose sort metric is unknown always sort last.",
  },
];

/** Which timeframe the `*Selected` outputs and the flow filters read. */
export const PAIR_TIMEFRAME_PARAMS: readonly ProtocolParamDef[] = [
  {
    key: "window",
    type: "string",
    description:
      "m5 | h1 | h6 | h24 (default h24). Selects the window behind volumeUsdSelected, "
      + "priceChangePctSelected and the volume/txn/price-change filters. Measured coverage: volume "
      + "and txns carry all four windows on 100% of rows, but priceChange carries m5 on only 31% "
      + "of rows, h1 61%, h6 74%, h24 87% — a price-change filter has nothing to compare on the "
      + "rest, and drops them.",
  },
  {
    key: "includeAllWindows",
    type: "boolean",
    description:
      "Emit all four windows of volume, txns, price change, buy/sell ratio and turnover on every "
      + "row instead of just the selected one (adds roughly 250 B per row).",
  },
];

/** Venue / pool-variant filters. Meaningful on every pair list. */
export const PAIR_VENUE_FILTER_PARAMS: readonly ProtocolParamDef[] = [
  {
    key: "dexIds",
    type: "string",
    acceptsStringArray: true,
    description:
      `Comma-separated venue slugs to keep, matched case-insensitively. ${STRING_OR_ARRAY_CLAUSE} `
      + `${WINDOW_CLAUSE} `
      + "52 distinct values observed and 4 of them are raw contract addresses for unnamed venues, "
      + "so an unrecognised value is not necessarily a mistake.",
  },
  {
    key: "excludeDexIds",
    type: "string",
    acceptsStringArray: true,
    description:
      "Comma-separated venue slugs to drop, matched case-insensitively. "
      + `${STRING_OR_ARRAY_CLAUSE} ${WINDOW_CLAUSE}`,
  },
  {
    key: "labels",
    type: "string",
    acceptsStringArray: true,
    description:
      "Comma-separated pool-variant tags to keep, matched case-insensitively because the provider "
      + `emits both V2 and v2. ${STRING_OR_ARRAY_CLAUSE} `
      + "Observed: v1 v2 v3 v4 V0.5 CLMM CPMM DLMM DYN DYN2 tri wp. Undocumented set; it may grow.",
  },
  {
    key: "quoteSymbols",
    type: "string",
    acceptsStringArray: true,
    description:
      "Comma-separated quote-asset symbols to keep (e.g. USDC,USDT,WETH,SOL), matched "
      + `case-insensitively. ${STRING_OR_ARRAY_CLAUSE}`,
  },
];

/** Absolute thresholds. Never percentages of the sample. */
export const PAIR_THRESHOLD_FILTER_PARAMS: readonly ProtocolParamDef[] = [
  {
    key: "minLiquidityUsd",
    type: "number",
    description:
      "Keep rows whose liquidityUsd is at least this. WARNING: USD liquidity is derived "
      + "from a price the pool itself sets and can be fabricated — measured on one live search, 13 "
      + "of 30 rows reported over $1M while holding fewer than 1,000 quote tokens, the worst "
      + "$1.63B against 59.72. Pair this with minTurnoverRatio or minQuoteDepthTokens. 0 is a "
      + "genuine no-op.",
  },
  { key: "maxLiquidityUsd", type: "number", description: "Keep rows whose liquidityUsd is at or below this." },
  {
    key: "minTurnoverRatio",
    type: "number",
    description:
      "Keep rows whose turnoverRatioH24 (24h volume divided by USD liquidity) is at least this. The cheapest real "
      + "defence against fabricated depth: a genuine Ethereum WETH/USDC pool measured about 0.22, "
      + "an impostor reporting $1.63B measured 0.00013. Rows where either input is missing are "
      + "dropped and counted in droppedByFilter. 0 is a genuine no-op.",
  },
  { key: "maxTurnoverRatio", type: "number", description: "Keep rows whose turnoverRatioH24 is at or below this." },
  {
    key: "minQuoteDepthTokens",
    type: "number",
    description:
      "Keep rows whose liquidityQuoteTokens is at least this — QUOTE TOKENS, not USD. Request "
      + "liquidityQuoteTokens in `fields` and the number itself comes back. The pool's real exit "
      + "liquidity, in the quote asset's own units (quoteSymbol names it). Priced at the quote token's independent value, "
      + "this is the one depth number a pool cannot inflate by mispricing itself. 0 is a genuine "
      + "no-op.",
  },
  {
    key: "minVolumeUsd",
    type: "number",
    description:
      "Keep rows whose volumeUsdSelected is at least this — USD traded in the selected `window`. "
      + "0 is a genuine no-op.",
  },
  { key: "maxVolumeUsd", type: "number", description: "Keep rows whose volumeUsdSelected is at or below this." },
  { key: "minFdvUsd", type: "number", description: "Keep rows whose fdvUsd is at least this. Fake when the pool's price is fake. 0 is a genuine no-op." },
  { key: "maxFdvUsd", type: "number", description: "Keep rows whose fdvUsd is at or below this." },
  {
    key: "minMarketCapUsd",
    type: "number",
    description:
      "Keep rows whose marketCapUsd is at least this. Measured, market cap equals FDV on 58% of "
      + "rows, which means circulating supply is UNKNOWN rather than fully circulating — request "
      + "the marketCapEqualsFdv field to see which rows those are. 0 is a genuine no-op.",
  },
  { key: "maxMarketCapUsd", type: "number", description: "Keep rows whose marketCapUsd is at or below this." },
  {
    key: "minTxnCount",
    type: "number",
    description:
      "Keep rows with at least this many buys + sells in the selected `window`. Vex computes the sum "
      + "and does NOT emit it as one field — request txnBuyCount<Window> and txnSellCount<Window> "
      + "(e.g. txnBuyCountH24) in `fields`, which carry the two parts. Whole number. 0 is a genuine "
      + "no-op.",
  },
  {
    key: "minBuySellRatio",
    type: "number",
    description:
      "Keep rows whose buys / sells in the selected `window` is at least this — emitted only per "
      + "window, as buySellRatio<Window> (e.g. buySellRatioH24), never as a *Selected field. Rows "
      + "with zero sells have no ratio and are dropped rather than treated as infinite. 0 is a "
      + "genuine no-op.",
  },
  {
    key: "maxBuySellRatio",
    type: "number",
    description:
      "Keep rows whose buys / sells in the selected `window` is at or below this. Read it back as "
      + "buySellRatio<Window>.",
  },
  {
    key: "minPriceChangePct",
    type: "number",
    description:
      "Keep rows whose priceChangePctSelected is at least this, ALREADY IN PERCENT "
      + "(1.08 = +1.08%). May be negative. Unlike the USD floors, 0 is a real threshold here "
      + "('flat or up'), not a no-op.",
  },
  {
    key: "maxPriceChangePct",
    type: "number",
    description:
      "Keep rows whose priceChangePctSelected is at or below this, already in percent. May be "
      + "negative.",
  },
];

/** Age filters. */
export const PAIR_AGE_FILTER_PARAMS: readonly ProtocolParamDef[] = [
  {
    key: "maxPairAgeSeconds",
    type: "number",
    description:
      "Keep pools whose pairAgeSeconds is at or below this, computed from pairCreatedAt against asOfMs. "
      + "pairCreatedAt is absent on about 9% of rows and those rows are EXCLUDED and counted in "
      + "droppedByFilter.unknownAge. How fresh a pool you can reach at all depends on the entry "
      + "point: arriving via dexscreener.profiles.recent, a 5-minute-old pool has been observed "
      + "(4 samples — a proven floor, not a typical value), whereas dexscreener.search returns "
      + "established pools by its own relevance and will not surface them. DexScreener publishes "
      + "no new-pair stream and every response is edge-cached about 30s, so nothing here is "
      + "real-time. And there is no category field anywhere in this API: pair age, turnover, venue "
      + "and whether socials exist are the only proxies available, and none of them means "
      + "'memecoin'.",
  },
  {
    key: "minPairAgeSeconds",
    type: "number",
    description:
      "Keep pools whose pairAgeSeconds is at least this. Rows with no pairCreatedAt are excluded and "
      + "counted in droppedByFilter.unknownAge. Whole number.",
  },
];

/** Quality flags. All tri-state-aware. */
export const PAIR_QUALITY_FILTER_PARAMS: readonly ProtocolParamDef[] = [
  {
    key: "requireSocials",
    type: "boolean",
    description:
      "Keep only rows with at least one social link. The provider's info block is present on only "
      + "67% of rows, so a row with no info block is UNKNOWN rather than social-less — it is "
      + "dropped, because the flag asks us to prove presence.",
  },
  {
    key: "requireWebsite",
    type: "boolean",
    description: "Keep only rows with at least one website. Same unknown-is-dropped rule as requireSocials.",
  },
  {
    key: "requirePriceUsd",
    type: "boolean",
    description: "Keep only rows that carry a USD price.",
  },
  {
    key: "onlyBoosted",
    type: "boolean",
    description:
      "Keep only rows with an active paid boost. Nearly useless over pair rows — measured on 1 of "
      + "489 — use dexscreener.boosts or dexscreener.ads for paid-visibility feeds.",
  },
];

/**
 * The whole shared vocabulary, in the order an agent reads it.
 *
 * `chainIds` is NOT here: it only means something where the provider mixed chains
 * into one window, which is `dexscreener.search` alone. On the other three tools
 * every row is already on the `chainId` the caller supplied.
 */
export const PAIR_LIST_PARAMS: readonly ProtocolParamDef[] = [
  ...PAIR_WINDOW_PARAMS,
  PAIR_OMIT_FIELDS_PARAM,
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
 * (`Buffer.byteLength(result.output, "utf8")`, per `tool-output-overflow.ts`) —
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

/** `search`, bare: measured 24,139 B — over the 16,384 B tool-output cap. */
export const SEARCH_LIST_PARAMS: readonly ProtocolParamDef[] = withBareCallByteCost(
  PAIR_LIST_PARAMS,
  "MEASURED: one bare pair-notation query with no limit returned 24,139 B against the 16,384 B "
    + "tool-output cap. The widest queries genuinely overflow, and `limit` is what bounds them.",
);

/**
 * `dexscreener.tokens` — one arbitrary pool per requested token address.
 *
 * Venue, label and quote-asset filters are omitted: each row is a DIFFERENT
 * token's single provider-chosen pool, so filtering the set by venue answers a
 * question nobody asked ("which of my holdings happens to have been quoted on
 * raydium"). Paging, sorting, projection and the economic thresholds all still
 * mean what they say across a portfolio.
 */
export const PAIR_BATCH_PARAMS: readonly ProtocolParamDef[] = [
  ...PAIR_WINDOW_PARAMS,
  PAIR_OMIT_FIELDS_PARAM,
  ...PAIR_SORT_PARAMS,
  ...PAIR_TIMEFRAME_PARAMS,
  ...PAIR_THRESHOLD_FILTER_PARAMS,
  EXPLAIN_DROPS_PARAM,
];

/** `tokens`, bare with 41 addresses: measured 17,822 B — over the cap. */
export const TOKENS_BATCH_PARAMS: readonly ProtocolParamDef[] = withBareCallByteCost(
  PAIR_BATCH_PARAMS,
  "MEASURED: 41 addresses with no limit returned 17,822 B against the 16,384 B tool-output cap. "
    + "The mandatory address reconciliation is part of that cost and is never windowed, so `limit` "
    + "shortens the ROWS while requestedAddresses/unresolvedAddresses stay complete.",
);

/**
 * `search` only — the one tool whose provider window spans several chains.
 *
 * The `q=arbitrum` trap lives on the `query` param, not here: that is where the
 * mistake is made, and repeating the same warning on two params would be two
 * copies to keep true.
 */
export const SEARCH_CHAIN_FILTER_PARAM: ProtocolParamDef = {
  key: "chainIds",
  type: "string",
  acceptsStringArray: true,
  description:
    "Comma-separated slugs to keep (e.g. ethereum,base,solana), matched case-insensitively and "
    + `echoed lowercase. ${STRING_OR_ARRAY_CLAUSE} `
    + "DexScreener applies no server-side equivalent, so this only subtracts "
    + "from the at most 30 rows it already chose: an EMPTY RESULT DOES NOT MEAN THERE IS NO POOL "
    + "THERE. Read droppedByFilter to tell the two apart, then use dexscreener.tokenPairs to ask "
    + "the question properly.",
};
