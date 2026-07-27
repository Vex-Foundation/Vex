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
    description:
      `Comma-separated venue slugs to keep, matched case-insensitively. ${WINDOW_CLAUSE} `
      + "52 distinct values observed and 4 of them are raw contract addresses for unnamed venues, "
      + "so an unrecognised value is not necessarily a mistake.",
  },
  {
    key: "excludeDexIds",
    type: "string",
    description: `Comma-separated venue slugs to drop, matched case-insensitively. ${WINDOW_CLAUSE}`,
  },
  {
    key: "labels",
    type: "string",
    description:
      "Comma-separated pool-variant tags to keep, matched case-insensitively because the provider "
      + "emits both V2 and v2. Observed: v1 v2 v3 v4 V0.5 CLMM CPMM DLMM DYN DYN2 tri wp. "
      + "Undocumented set; it may grow.",
  },
  {
    key: "quoteSymbols",
    type: "string",
    description:
      "Comma-separated quote-asset symbols to keep (e.g. USDC,USDT,WETH,SOL), matched "
      + "case-insensitively.",
  },
];

/** Absolute thresholds. Never percentages of the sample. */
export const PAIR_THRESHOLD_FILTER_PARAMS: readonly ProtocolParamDef[] = [
  {
    key: "minLiquidityUsd",
    type: "number",
    description:
      "Keep rows with at least this much reported USD liquidity. WARNING: USD liquidity is derived "
      + "from a price the pool itself sets and can be fabricated — measured on one live search, 13 "
      + "of 30 rows reported over $1M while holding fewer than 1,000 quote tokens, the worst "
      + "$1.63B against 59.72. Pair this with minTurnoverRatio or minQuoteDepthTokens. 0 is a "
      + "genuine no-op.",
  },
  { key: "maxLiquidityUsd", type: "number", description: "Keep rows at or below this reported USD liquidity." },
  {
    key: "minTurnoverRatio",
    type: "number",
    description:
      "Keep rows whose 24h volume divided by USD liquidity is at least this. The cheapest real "
      + "defence against fabricated depth: a genuine Ethereum WETH/USDC pool measured about 0.22, "
      + "an impostor reporting $1.63B measured 0.00013. Rows where either input is missing are "
      + "dropped and counted in droppedByFilter. 0 is a genuine no-op.",
  },
  { key: "maxTurnoverRatio", type: "number", description: "Keep rows whose 24h volume / USD liquidity is at or below this." },
  {
    key: "minQuoteDepthTokens",
    type: "number",
    description:
      "Keep rows holding at least this many QUOTE TOKENS (not USD) — the pool's real exit "
      + "liquidity, in the quote asset's own units. Priced at the quote token's independent value, "
      + "this is the one depth number a pool cannot inflate by mispricing itself. 0 is a genuine "
      + "no-op.",
  },
  {
    key: "minVolumeUsd",
    type: "number",
    description: "Keep rows with at least this much USD volume in the selected `window`. 0 is a genuine no-op.",
  },
  { key: "maxVolumeUsd", type: "number", description: "Keep rows at or below this USD volume in the selected `window`." },
  { key: "minFdvUsd", type: "number", description: "Keep rows with at least this FDV in USD. Fake when the pool's price is fake. 0 is a genuine no-op." },
  { key: "maxFdvUsd", type: "number", description: "Keep rows at or below this FDV in USD." },
  {
    key: "minMarketCapUsd",
    type: "number",
    description:
      "Keep rows with at least this market cap in USD. Measured, market cap equals FDV on 58% of "
      + "rows, which means circulating supply is UNKNOWN rather than fully circulating — request "
      + "the marketCapEqualsFdv field to see which rows those are. 0 is a genuine no-op.",
  },
  { key: "maxMarketCapUsd", type: "number", description: "Keep rows at or below this market cap in USD." },
  {
    key: "minTxnCount",
    type: "number",
    description: "Keep rows with at least this many buys + sells in the selected `window`. Whole number. 0 is a genuine no-op.",
  },
  {
    key: "minBuySellRatio",
    type: "number",
    description:
      "Keep rows whose buys / sells in the selected `window` is at least this. Rows with zero "
      + "sells have no ratio and are dropped rather than treated as infinite. 0 is a genuine no-op.",
  },
  { key: "maxBuySellRatio", type: "number", description: "Keep rows whose buys / sells in the selected `window` is at or below this." },
  {
    key: "minPriceChangePct",
    type: "number",
    description:
      "Keep rows whose price change in the selected `window` is at least this, ALREADY IN PERCENT "
      + "(1.08 = +1.08%). May be negative. Unlike the USD floors, 0 is a real threshold here "
      + "('flat or up'), not a no-op.",
  },
  {
    key: "maxPriceChangePct",
    type: "number",
    description: "Keep rows whose percent price change in the selected `window` is at or below this. May be negative.",
  },
];

/** Age filters. */
export const PAIR_AGE_FILTER_PARAMS: readonly ProtocolParamDef[] = [
  {
    key: "maxPairAgeSeconds",
    type: "number",
    description:
      "Keep pools created within this many seconds, computed from pairCreatedAt against asOfMs. "
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
      "Keep pools at least this many seconds old. Rows with no pairCreatedAt are excluded and "
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
  ...PAIR_SORT_PARAMS,
  ...PAIR_TIMEFRAME_PARAMS,
  ...PAIR_VENUE_FILTER_PARAMS,
  ...PAIR_THRESHOLD_FILTER_PARAMS,
  ...PAIR_AGE_FILTER_PARAMS,
  ...PAIR_QUALITY_FILTER_PARAMS,
];

/**
 * `dexscreener.pairs` — stats for pools the caller already named.
 *
 * The pipeline accepts the whole vocabulary here too, but only these are worth
 * ADVERTISING: the response is the pools you asked for, so there is nothing for a
 * liquidity floor, a venue filter or a sort to discriminate between. Declaring
 * `minBuySellRatio` on a one-row answer would be a filter that can only ever
 * return the row or nothing.
 */
export const PAIR_LOOKUP_PARAMS: readonly ProtocolParamDef[] = [
  ...PAIR_WINDOW_PARAMS.filter((param) => param.key === "fields"),
  ...PAIR_TIMEFRAME_PARAMS,
];

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
  ...PAIR_SORT_PARAMS,
  ...PAIR_TIMEFRAME_PARAMS,
  ...PAIR_THRESHOLD_FILTER_PARAMS,
];

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
  description:
    "Comma-separated slugs to keep (e.g. ethereum,base,solana), matched case-insensitively and "
    + "echoed lowercase. DexScreener applies no server-side equivalent, so this only subtracts "
    + "from the at most 30 rows it already chose: an EMPTY RESULT DOES NOT MEAN THERE IS NO POOL "
    + "THERE. Read droppedByFilter to tell the two apart, then use dexscreener.tokenPairs to ask "
    + "the question properly.",
};
