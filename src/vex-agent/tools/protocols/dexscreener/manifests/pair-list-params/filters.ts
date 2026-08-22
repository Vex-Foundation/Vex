/**
 * The params that SUBTRACT rows from a DexScreener pair answer — venue,
 * economic thresholds, age and quality flags (split out of
 * `../pair-list-params.ts` in 0R.16, refactor-only). Every threshold here is
 * ABSOLUTE, never a percentage of the sample, and every one of them can only
 * narrow the at most 30 rows the provider already chose.
 */

import type { ProtocolParamDef } from "../../../types.js";
import { STRING_OR_ARRAY_CLAUSE, WINDOW_CLAUSE } from "./clauses.js";

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
      + "an impostor reporting $1.63B measured 0.00013. INVERSION ON DEEP POOLS: the canonical "
      + "$20M PEPE/WETH pool measured 0.018 - deep blue-chip pools legitimately sit far below "
      + "thresholds that catch impostors, so this filter can delete exactly the genuine token. "
      + "Pair it with explainDrops and read droppedByFilter before concluding anything from an "
      + "empty result. Rows where either input is missing are "
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
      + "point: arriving via dexscreener__profiles_list with feed: recentUpdates, a 5-minute-old pool has been observed "
      + "(4 samples - a proven floor, not a typical value) - and the window's HORIZON is just as "
      + "bounded: one live 30-row window's oldest reachable row measured about 85 minutes, so a "
      + "feed sweep is a sample of a narrow live window, never a survey of 'the last N hours' - "
      + "whereas dexscreener__pairs_search returns "
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
    key: "requireLiquidityUsd",
    type: "boolean",
    description:
      // The measured batch ran on Solana, but the chain name stays out of this
      // text: a param field carrying a chain name inflates this namespace's
      // lexical score for that chain's OWN tools (measured: "solana token
      // search" pushed solana.tokens out of the discovery top-3).
      "Keep only rows that carry a USD liquidity figure. Pre-graduation bonding-curve pools "
      + "(measured: every pumpfun row in a live 20-row batch, 9 of 20) legitimately report "
      + "liquidityUsd: null - null means UNKNOWN reserves, not zero - and turnoverRatioH24 is null "
      + "with it, so liquidity-based sorting and the turnover defence are unavailable on exactly "
      + "those rows. Dropped rows are counted in droppedByFilter.requireLiquidityUsd.",
  },
  {
    key: "onlyBoosted",
    type: "boolean",
    description:
      "Keep only rows with an active paid boost. Nearly useless over pair rows — measured on 1 of "
      + "489 - use dexscreener__boosts_list or dexscreener__ads_list for paid-visibility feeds.",
  },
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
  acceptsStringArray: true,
  description:
    "Comma-separated slugs to keep (e.g. ethereum,base,solana), matched case-insensitively and "
    + `echoed lowercase. ${STRING_OR_ARRAY_CLAUSE} `
    + "DexScreener applies no server-side equivalent, so this only subtracts "
    + "from the at most 30 rows it already chose: an EMPTY RESULT DOES NOT MEAN THERE IS NO POOL "
    + "THERE. Read droppedByFilter to tell the two apart, then use dexscreener__token_pairs_list to ask "
    + "the question properly.",
};
