/**
 * The site screening family (6 boards), the chain catalog, and the token-level
 * screen: 8 read-only tools on DexScreener's own website channels.
 *
 * WHY THESE ARE SEPARATE TOOLS AND NOT ONE. All six boards reach one provider
 * channel and share `./screen-params.ts` in full. They differ in the sort key
 * they PIN, the default floors they apply, and the intent they are retrieved
 * by. That last one is the reason the split exists: "what is pumping" and
 * "biggest liquidity pools" are different questions, and a single tool with a
 * `sortBy` the model has to guess correctly retrieves worse than six tools whose
 * names say what they answer.
 *
 * WHY THE DESCRIPTIONS READ THE WAY THEY DO. Every `description` here begins
 * from the model-visible draft in
 * `tool-surface-spec/dexscreener-site/tool-descriptions-v1.md` (owner decision
 * D-DS7) and extends it only with units, if-omitted semantics, and the shared
 * honesty clauses. No sentence of a draft is dropped or reworded.
 *
 * All 8 are `mutating: false`, `actionKind: "read"`, and need no API key.
 */

import type { ProtocolToolManifest, ProtocolParamDef } from "../../types.js";
import { CANONICAL_CHAIN_SENTENCE } from "../../conventions.js";
import { DEXSCREENER_SCREENING_DISCOVERY } from "../../embeddings/dexscreener/screening.js";
import {
  SCREEN_PARAMS,
  withDisableQualityFloor,
  withoutParam,
  withParamNotes,
  withSortBy,
} from "./screen-params.js";
import {
  SCREEN_EXTERNAL_CONTENT_CLAUSE,
  SCREEN_FLOOR_CLAUSE,
  SCREEN_PROVIDER_WINDOW_CLAUSE,
  SCREEN_SOURCE_OBSERVATION_CLAUSE,
  SCREEN_TOTAL_CLAUSE,
} from "./screen-params/clauses.js";

/** The clauses every board carries, in one order, once. */
const BOARD_TAIL = `${SCREEN_PROVIDER_WINDOW_CLAUSE} ${SCREEN_TOTAL_CLAUSE} ${SCREEN_EXTERNAL_CONTENT_CLAUSE} ${SCREEN_SOURCE_OBSERVATION_CLAUSE}`;

/** The same, for the boards that also apply a default quality floor. */
const FLOORED_BOARD_TAIL = `${SCREEN_FLOOR_CLAUSE} ${BOARD_TAIL}`;

/** A worked call every board accepts, so the example is callable as written. */
const BOARD_EXAMPLE = { chainIds: "solana", window: "h24", limit: 20 };

/* ------------------------------------------------------------------ */
/* Tool-specific params                                                */
/* ------------------------------------------------------------------ */

const TOP_SORT_BY: ProtocolParamDef = {
  key: "sortBy",
  type: "string",
  enum: ["volume", "txns", "buys", "sells", "liquidity", "marketCap", "boosts"],
  description:
    "Which hard metric ranks the board: volume, txns, buys, sells, liquidity, marketCap or "
    + "boosts. Defaults to volume. volume, txns, buys and sells are measured over the selected "
    + "window; liquidity and marketCap are point-in-time and ignore it. boosts ranks by the count "
    + "of ACTIVE paid boosts (measured live: 100 rows served from a 54,051 population) and is an "
    + "advertising ranking, never a demand or safety one; pair it with maxBoostCount to bound the "
    + "other end. Sorting by fdv is deliberately "
    + "not offered: the provider returns the txns ordering for it, identical on 100 of 100 "
    + "measured rows, so filter with minFdvUsd or maxFdvUsd and rank by marketCap instead.",
};

const TOP_SORT_DIR: ProtocolParamDef = {
  key: "sortDir",
  type: "string",
  enum: ["desc", "asc"],
  description:
    "Ranking direction: desc for the largest values first, asc for the smallest. Defaults to "
    + "desc, which is the league-table reading. asc is how you find the thinnest pools that still "
    + "pass your filters.",
};

const LAUNCHPAD_STAGE: ProtocolParamDef = {
  key: "stage",
  type: "string",
  enum: ["bonding", "graduated"],
  description:
    "Which side of graduation to list: bonding for tokens still on the curve, graduated for "
    + "tokens that completed it and migrated to a DEX. Defaults to bonding. The stage sets the "
    + "default progress floor, so bonding lists below 100 percent complete and graduated lists at "
    + "100 percent.",
};

const LAUNCHPAD_SORT_BY: ProtocolParamDef = {
  key: "sortBy",
  type: "string",
  enum: ["launchpadProgress", "trendingScore", "priceChange", "volume", "txns", "marketCap", "pairAge"],
  description:
    "Which metric ranks the board: launchpadProgress, trendingScore, priceChange, volume, txns, "
    + "marketCap or pairAge. Defaults to launchpadProgress on the bonding stage, which is the "
    + "near-graduation question, and to trendingScore on the graduated stage, where progress is "
    + "100 for every row and would rank nothing.",
};

const TOKENS_SORT_BY: ProtocolParamDef = {
  key: "sortBy",
  type: "string",
  enum: ["trendingScore", "volume", "txns", "liquidity", "priceChange", "pairAge"],
  description:
    "Which provider rank key orders the token rows: trendingScore, volume, txns, liquidity, "
    + "priceChange or pairAge. Defaults to trendingScore. pairAge ranks by creation time and is "
    + "the only way to ask this channel for the newest tokens; it defaults to ascending (newest "
    + "first), and sortDir overrides that like any other key. Ranking by marketCap is deliberately "
    + "NOT offered: the provider accepts it and answers with a degenerate board (measured "
    + "2026-08-25 on solana: 43 rows in total, 18 of 42 adjacent pairs out of order, JUP served at "
    + "3.68 trillion USD and PUMP at 23.98 trillion, quoted in junk pairs), so filter with "
    + "minMarketCapUsd or maxMarketCapUsd and rank by liquidity or volume instead. HONEST LIMIT, "
    + "measured: the served order is provider-opaque and does not reproduce from any visible "
    + "metric (48 to 51 ordering violations of 99 adjacent pairs against every single-metric "
    + "reconstruction tried), so treat the order as the provider's opinion and the per-row numbers "
    + "as the facts.",
};

const TOKENS_SORT_DIR: ProtocolParamDef = {
  key: "sortDir",
  type: "string",
  enum: ["desc", "asc"],
  description:
    "Ranking direction: desc for the largest values first, asc for the smallest. Defaults to desc "
    + "on every key except pairAge, which defaults to asc so that the newest tokens come first; "
    + "rankApplied echoes the direction that actually ran. Measured honoured live on this channel "
    + "2026-08-25: pairAge desc served tokens created in 2022 and 2023, pairAge asc served tokens "
    + "created the same day. Note that asc on a metric key surfaces the bottom of the population, "
    + "where the metric is frequently absent rather than small.",
};

const CHAINS_CHAIN: ProtocolParamDef = {
  key: "chain",
  type: "string",
  required: false,
  description:
    "Narrow the catalog to one chain. Omit it to list every supported chain. Narrowing does "
    + "not add detail: every row carries that chain's complete DEX list either way, so this "
    + `only changes how many rows come back. ${CANONICAL_CHAIN_SENTENCE}`,
};

/**
 * The gainers and losers vocabulary: one value, because the two boards are the
 * same query with the sort direction flipped and must never drift apart. A
 * second copy is exactly how one board's floor gets corrected and the other's
 * does not.
 */
const GAINER_LOSER_PARAMS: readonly ProtocolParamDef[] = withParamNotes(
  [...SCREEN_PARAMS],
  [
    ["minTxnCount", "This board applies 300 over h24 by default."],
    ["minSellCount", "This board applies 30 over h24 by default."],
    ["minVolumeUsd", "This board applies 100,000 USD over h24 by default."],
    ["minLiquidityUsd", "This board applies 250,000 USD by default."],
    ["requireProfile", "This board applies true by default."],
  ]
);

/* ------------------------------------------------------------------ */
/* Manifests                                                           */
/* ------------------------------------------------------------------ */

export const SCREENING_TOOLS: readonly ProtocolToolManifest[] = [
  {
    toolId: "dexscreener.pairs.trending",
    publicName: "dexscreener__pairs_trending_list",
    namespace: "dexscreener",
    lifecycle: "active",
    description:
      "List pairs ranked by DexScreener's trending score for the selected `window` "
      + "(m5, h1, h6, h24) on the selected chains. Use this when the question is about "
      + "attention and momentum rather than a strict metric sort. Returns up to 100 rows "
      + "per page with price, priceChange, volume, liquidity, marketCap, buys/sells, "
      + "buyers/sellers/makers, derived flow ratios, and the row's volume share of the frame "
      + "(`chainVolumeSharePct` when the query names exactly one chain, and "
      + "`filteredSetVolumeSharePct` when it spans more, because a multi-chain denominator is not "
      + "a chain share); the "
      + "envelope carries the provider's total match estimate and `marketStats` for the "
      + "whole filtered set. All screening filters (liquidity, volume, age, dex, "
      + "narrative, launchpad) apply. Trending order mixes organic activity with paid "
      + "boosts; boost counts are shown per row so the agent can judge. "
      + "This board applies no default quality floor, so every threshold is yours to set. "
      + BOARD_TAIL,
    mutating: false,
    actionKind: "read",
    params: [...SCREEN_PARAMS],
    exampleParams: BOARD_EXAMPLE,
    discovery: DEXSCREENER_SCREENING_DISCOVERY["dexscreener.pairs.trending"],
  },

  {
    toolId: "dexscreener.pairs.top",
    publicName: "dexscreener__pairs_top_list",
    namespace: "dexscreener",
    lifecycle: "active",
    description:
      "List pairs ordered by a chosen `sortBy` metric (volume, txns, buys, sells, "
      + "liquidity, marketCap, boosts) within the selected `window`. Use this for league-table "
      + "questions with measurable answers. Returns metric-complete rows plus derived "
      + "ratios (turnover, net flow, transactions per maker) and the filtered set's "
      + "aggregate stats. `fdv` sorting is not offered because the provider returns a "
      + "wrong ordering for it (measured defect); filter by `minFdvUsd`/`maxFdvUsd` and "
      + "sort by marketCap instead. Use this when the user names a measurable quantity (most "
      + "volume, most trades, deepest liquidity, largest market cap) rather than asking what is "
      + "hot. "
      + "Ranking by volume or txns applies a default floor so the board is not led by "
      + "untradeable rows; the other sorts apply none. "
      + FLOORED_BOARD_TAIL,
    mutating: false,
    actionKind: "read",
    params: [
      ...withDisableQualityFloor(
        withSortBy(withSortBy([...SCREEN_PARAMS], TOP_SORT_BY), TOP_SORT_DIR)
      ),
    ],
    exampleParams: { chainIds: "solana", sortBy: "volume", window: "h24", limit: 20 },
    discovery: DEXSCREENER_SCREENING_DISCOVERY["dexscreener.pairs.top"],
  },

  {
    toolId: "dexscreener.gainers",
    publicName: "dexscreener__gainers_list",
    namespace: "dexscreener",
    lifecycle: "active",
    description:
      "List pairs by price change descending for the selected `window`, with the "
      + "site's default quality floor applied and echoed in `filtersApplied`. Override "
      + "any threshold with a number, or set `disableQualityFloor: true` to drop every "
      + "default floor at once; `qualityFloorApplied` reflects what was actually sent. "
      + "Use this when the question is about "
      + "the strongest risers. Returns price change for all four windows, volume, "
      + "liquidity, flow ratios, and pair age, so a fresh low-liquidity spike is "
      + "distinguishable from a sustained move. Without the floor the provider's top "
      + "rows are arithmetic artifacts; removing it is explicit, never silent. "
      + "The default floor is h24-anchored exactly as the site sends it, even when the "
      + "ranking window is m5, h1 or h6: 300 transactions, 30 sells, 100,000 USD volume, "
      + "250,000 USD liquidity, and a token profile. "
      + FLOORED_BOARD_TAIL,
    mutating: false,
    actionKind: "read",
    params: [...withDisableQualityFloor(GAINER_LOSER_PARAMS)],
    exampleParams: BOARD_EXAMPLE,
    discovery: DEXSCREENER_SCREENING_DISCOVERY["dexscreener.gainers"],
  },

  {
    toolId: "dexscreener.losers",
    publicName: "dexscreener__losers_list",
    namespace: "dexscreener",
    lifecycle: "active",
    description:
      "List pairs by price change ascending for the selected `window`, floored and "
      + "echoed exactly like the gainers tool. Use this when the question is about the "
      + "deepest declines. Returns the same row shape as gainers including sell-side "
      + "flow (sellers, sell volume share, net outflow in USD), which is what "
      + "distinguishes a real exodus from a thin-book wick. "
      + "The default floor is h24-anchored exactly as the site sends it: 300 "
      + "transactions, 30 sells, 100,000 USD volume, 250,000 USD liquidity, and a token "
      + "profile. "
      + FLOORED_BOARD_TAIL,
    mutating: false,
    actionKind: "read",
    params: [...withDisableQualityFloor(GAINER_LOSER_PARAMS)],
    exampleParams: BOARD_EXAMPLE,
    discovery: DEXSCREENER_SCREENING_DISCOVERY["dexscreener.losers"],
  },

  {
    toolId: "dexscreener.pairs.new",
    publicName: "dexscreener__pairs_new_list",
    namespace: "dexscreener",
    lifecycle: "active",
    description:
      "List pairs ordered by creation time, newest first, filtered by `maxPairAgeSeconds` "
      + "(default 86400) and `minLiquidityUsd` (default 1000, removable). Use this when "
      + "recency is the question. Returns exact `pairAgeSeconds`, liquidity, early "
      + "volume and buys/sells, `volumeAccelerationRatio` (is the last five minutes "
      + "hotter than the trailing hour), and the launchpad origin when the pair "
      + "graduated from one. Age filters are hours-precise on the provider; sub-hour "
      + "precision comes from the returned timestamps. "
      + "New pairs were measured appearing 17 to 39 seconds after creation, median 35.5 "
      + "seconds, so the freshest rows are seconds old rather than instant. "
      + FLOORED_BOARD_TAIL,
    mutating: false,
    actionKind: "read",
    params: [
      ...withDisableQualityFloor(
        withParamNotes([...SCREEN_PARAMS], [
          ["maxPairAgeSeconds", "This tool applies 86400 (one day) by default."],
          ["minLiquidityUsd", "This tool applies 1000 USD by default. Sending 0 does NOT remove the filter: 0 is still a floor, and the provider only matches a row that CARRIES a liquidity figure, so a liquidity threshold of any value excludes every bonding-curve pair (measured: 0 rows returned). Use disableQualityFloor to drop the key from the wire entirely. Even then this board does not lift the provider's hidden launchpad exclusion, so new bonding-curve pairs are reached through dexscreener__launchpad_pairs_list, not here."],
        ])
      ),
    ],
    exampleParams: { chainIds: "solana", maxPairAgeSeconds: 3600, limit: 20 },
    discovery: DEXSCREENER_SCREENING_DISCOVERY["dexscreener.pairs.new"],
  },

  {
    toolId: "dexscreener.launchpad.pairs",
    publicName: "dexscreener__launchpad_pairs_list",
    namespace: "dexscreener",
    lifecycle: "active",
    description:
      "List launchpad pairs by `stage`: `bonding` (still on the curve, ranked by "
      + "progress, price change, volume, or age) or `graduated` (completed and migrated, "
      + "ranked by trending, age, or market cap). Use this for launchpad questions; "
      + "the provider hides bonding pairs from normal screens and the tool lifts that "
      + "exclusion internally. Returns progress percent, creator address, migration "
      + "dex, market cap, and flow. Bonding rows carry NO liquidity field by provider "
      + "design (measured): size comparisons use `marketCapUsd`, and liquidity reads "
      + "`not_applicable` rather than zero. Use this when the question names a launchpad, a "
      + "bonding curve, or graduation. "
      + "Because bonding rows have no liquidity, any liquidity threshold excludes every "
      + "one of them; the tool reports that rather than returning an empty board. "
      + FLOORED_BOARD_TAIL,
    mutating: false,
    actionKind: "read",
    params: [
      LAUNCHPAD_STAGE,
      ...withDisableQualityFloor(
        withSortBy([...SCREEN_PARAMS], LAUNCHPAD_SORT_BY)
      ),
    ],
    // MEASURED: `launchpadIds` matches GRADUATED rows only, because the
    // provider attaches a launchpad id to a pair after migration and sends an
    // empty `launchpad.meta` while the curve runs. The previous example
    // (`stage: "bonding"` with `launchpadIds`) returned 0 rows of a 0-row
    // population, and the same call with `dexIds` returned a 53,478-row one.
    // The handler now refuses that pairing by name; the example shows the
    // filter that works on the stage it is shown with.
    exampleParams: { chainIds: "solana", stage: "bonding", dexIds: "pumpfun", limit: 20 },
    discovery: DEXSCREENER_SCREENING_DISCOVERY["dexscreener.launchpad.pairs"],
  },

  {
    toolId: "dexscreener.chains",
    publicName: "dexscreener__chains_list",
    namespace: "dexscreener",
    lifecycle: "active",
    description:
      "List the supported chains with their metadata; optional `chain` narrows to one. "
      + "Narrowing does not add detail: every row already carries that chain's complete dex "
      + "list, so the only thing `chain` changes is how many rows come back. "
      + "Use this to discover valid `chainIds` and `dexIds` "
      + "values before screening (the `labels` vocabulary is listed in that parameter's own "
      + "description, not here: this catalog carries no label list), and to build correct "
      + "explorer links from the returned URL templates. Returns per chain: slug, name, "
      + "nativeChainId, "
      + "architecture, dex count and slugs, explorer templates, audit integration keys "
      + "(presence of an integration is catalog metadata; whether an audit actually "
      + "answers for a given token is a per-token question this catalog does not answer), "
      + "and whether the SITE surfaces a narratives view for the chain. That last field is named "
      + "`narrativesSurfacedOnSite` because it is a site-visibility label and not a data gate: "
      + "narratives were measured aggregating live on robinhood, ton and polygon, none of which "
      + "the site surfaces, so false here does not mean the chain has none. "
      + "Cached daily; the catalog host serves it in one 63 KB response. "
      + "Row order and each row's dex list carry NO meaning: the provider ranks both live and "
      + "both drift (20+ adjacent transpositions measured nine minutes apart, and one chain's dex "
      + "order changed inside two minutes), so behind the 24 hour cache the order can be a day "
      + "old. Membership is stable; sequence is not. "
      + "The integration keys here say which audit providers a chain has AT ALL; to find out "
      + "what they actually report for one token, call `dexscreener__pair_details_get`, whose "
      + "coverage is derived from the response rather than from this catalog (measured: the "
      + "catalog carries a GoPlus KEY on 56 chains, 21 of those have it ENABLED, and the "
      + "enabled set is what this tool lists, so the 56 is a number you will not find in this "
      + "output; enabled is still not the same as answering for a given token). "
      + "Explorer templates: the placeholder NAME inside a template is the provider's own and "
      + "does not identify what the slot wants, in EITHER direction. Read the slot from the "
      + "FIELD instead: accountUrlTemplate takes a wallet address, assetUrlTemplate and "
      + "holdersUrlTemplate take a token address, txnsUrlTemplate takes a transaction hash. "
      + "Measured: holdersUrlTemplate wants a token address on all 21 chains where it is "
      + "spelled `{{txns}}`; taiko spells the same token slot `{{token}}` and beam's "
      + "assetUrlTemplate spells it `{{address}}`; and oasissapphire's txnsUrlTemplate "
      + "spells a TRANSACTION HASH slot `{{address}}`. Substituting by placeholder name "
      + "builds a dead link. "
      + "An unknown chain value is refused by name with the nearest catalog matches, "
      + "because the screening tools answer an unknown slug with zero rows and no error. "
      + SCREEN_SOURCE_OBSERVATION_CLAUSE,
    mutating: false,
    actionKind: "read",
    params: [CHAINS_CHAIN],
    exampleParams: { chain: "solana" },
    discovery: DEXSCREENER_SCREENING_DISCOVERY["dexscreener.chains"],
  },

  {
    toolId: "dexscreener.tokens.screen",
    publicName: "dexscreener__tokens_screen",
    namespace: "dexscreener",
    lifecycle: "active",
    description:
      "List token aggregate rows for the selected chains and `window`, up to 100 per page with "
      + "offset paging. Use this when the answer should be token rows rather than pool rows. "
      + "Returns per token: volume, liquidity, and transaction counts SUMMED across the token's "
      + "pools (the channel's real value), plus the representative pool the provider chose with "
      + "its price; that pool's marketCap and FDV are labelled representative-pool values and can "
      + "be wrong by orders of magnitude for multi-pool tokens. Honesty contract, measured: the "
      + "universe is the provider's profile-carrying tokens only; the ranking is the provider's "
      + "opaque score (`providerRank`, the row's 1-based position in the order served, offset "
      + "included); there is no server-side total; the same token can repeat across pages with "
      + "disjoint aggregates and repeats are flagged by token. For metric-exact league tables use "
      + "the pair screening tools. "
      + "Every one of those facts is carried in the response's `honesty` block with the "
      + "measurement behind it: the same pool measured 2.20x the liquidity here that it measured "
      + "on the pair channel at the same instant, JUP was served at 3.68 trillion USD of market "
      + "cap, and of 173 solana tokens clearing 5,000,000 USD of 24 hour volume this channel "
      + "returns 15 and calls the next page empty. A short board here is not evidence of a short "
      + "market. "
      + "Because this channel publishes no total, traversal is never exhaustive and "
      + "hasMore is decided by whether the last page came back full. "
      + `${SCREEN_EXTERNAL_CONTENT_CLAUSE} ${SCREEN_SOURCE_OBSERVATION_CLAUSE}`,
    mutating: false,
    actionKind: "read",
    // `requireProfile` is REMOVED here, not merely undocumented: it maps to
    // `filters[enhancedTokenInfo]`, which this channel ignores (baseline,
    // `=true` and `=false` returned byte-identical 91,955-byte frames), while
    // the envelope echoed it in `filtersApplied` as though it had selected
    // something. The channel is profile-only regardless, so the filter has
    // nothing left to express here.
    params: [
      ...withSortBy(
        withSortBy(withoutParam([...SCREEN_PARAMS], "requireProfile"), TOKENS_SORT_BY),
        TOKENS_SORT_DIR
      ),
    ],
    rejectedParams: {
      requireProfile:
        "This channel ignores the profile filter and serves profile-carrying tokens ONLY, whatever you send: baseline, true and false returned byte-identical frames with the same 100 tokens. The universe is already restricted, and that restriction is reported in the response's honesty block.",
    },
    exampleParams: { chainIds: "solana", window: "h24", limit: 20 },
    discovery: DEXSCREENER_SCREENING_DISCOVERY["dexscreener.tokens.screen"],
  },
];
