/**
 * The param vocabulary for `dexscreener.trending`.
 *
 * Same keys, same validation and the same absence of a default on `limit` as
 * `./pair-list-params.ts` and `./feed-list-params.ts`. `dexscreener.meta` takes the
 * PAIR vocabulary instead, because what it returns is pools.
 *
 * `trending` previously had one parameter — `limit`, with no maximum, and a
 * `0`-means-everything reading that meant "20" in `search`.
 */

import type { ProtocolParamDef } from "../../types.js";
import { EXPLAIN_DROPS_PARAM } from "./pair-list-params.js";

export const NARRATIVE_LIST_PARAMS: readonly ProtocolParamDef[] = [
  {
    key: "omitFields",
    type: "string",
    description:
      "Comma-separated output fields to REMOVE. Accepts one name: description — DexScreener's "
      + "editorial prose, which is unbounded and which no decision reads. It is opt-in here, so "
      + "this is only meaningful together with fields: \"full\": that pairing means 'every number, "
      + "none of the prose'. slug and the aggregates are what this feed exists to report and are "
      + "never omittable. Echoed back as fieldsOmitted.",
  },
  EXPLAIN_DROPS_PARAM,
  {
    key: "limit",
    type: "number",
    description:
      "Max narratives to return (1-200). Omit to receive EVERY narrative DexScreener returned — 19 "
      + "on the live feed, and the whole payload is under 7 KB, so there is rarely a reason to set "
      + "this. 0 is rejected because it cannot mean both 'none' and 'all'.",
  },
  {
    key: "offset",
    type: "number",
    description:
      "Skip this many narratives of the same provider window (default 0). The PROVIDER has no pagination: this "
      + "walks the single trending list Vex already fetched, so the reply's `hasMore` and `totalMatched` are "
      + "about that list. Continue by adding the reply's `returned` to this value while hasMore is true.",
  },
  {
    key: "fields",
    type: "string",
    description:
      "Comma-separated extra output fields, ADDED to the default row. Use 'full' for every field; a "
      + "misspelled name is rejected with the complete accepted list. Opt-in covers the narrative "
      + "description and each individual m5/h1/h6/h24 window of market-cap change (percent) and "
      + "market-cap delta (absolute USD) — two different units the provider ships in two "
      + "identically-shaped, unnamed maps.",
  },
  {
    key: "sortBy",
    type: "string",
    description:
      "relevance | marketCapUsd | liquidityUsd | volumeUsdH24 | narrativeTokenCount | "
      + "marketCapChangePct. Default 'relevance', meaning 'as DexScreener returned'. DexScreener "
      + "DOES NOT DISCLOSE ITS ORDER and it is not a ranking: nine candidate sorts (market cap, "
      + "liquidity, volume, token count and each change window, both directions) were tested against "
      + "the live feed and none reproduces it, so position carries no meaning. Sort by "
      + "marketCapChangePct to see what is ROTATING; the largest narrative is rarely the moving one.",
  },
  {
    key: "sortDir",
    type: "string",
    description:
      "desc (default) or asc. Narratives whose sort metric is unknown always sort last, in both "
      + "directions.",
  },
  {
    key: "window",
    type: "string",
    description:
      "m5 | h1 | h6 | h24 (default h24). Selects the window behind marketCapChangePctSelected and "
      + "behind a marketCapChangePct sort. Unlike the pair tools, all four windows were present on "
      + "every live narrative row.",
  },
  {
    key: "minTokenCount",
    type: "number",
    description:
      "Keep narratives whose narrativeTokenCount — how many tokens DexScreener counts in the "
      + "narrative — is at least this. This is "
      + "the narrative-level count and it disagrees with what dexscreener__narrative_get reports for the same "
      + "slug — measured 67 here against 31 there, in the same minute. This tool owns the "
      + "narrative-level number. 0 is a genuine no-op; whole number.",
  },
  {
    key: "minMarketCapUsd",
    type: "number",
    description:
      "Keep narratives whose marketCapUsd is at least this, in USD. Aggregated by DexScreener "
      + "over tokens whose individual market caps are derived from pool prices a pool can set "
      + "itself, so a fabricated token price inflates its narrative too. 0 is a genuine no-op.",
  },
  {
    key: "minLiquidityUsd",
    type: "number",
    description:
      "Keep narratives whose liquidityUsd is at least this. Note the provider's aggregate is "
      + "NOT the sum of the pools it will show you for that narrative — measured 23,354,089.77 "
      + "reported against 21,774,508.92 summed. 0 is a genuine no-op.",
  },
  {
    key: "minVolumeUsd",
    type: "number",
    description:
      "Keep narratives whose volumeUsdH24 is at least this. Same caveat as minLiquidityUsd: "
      + "the aggregate is not a sum over the pools dexscreener__narrative_get returns. 0 is a genuine no-op.",
  },
];
