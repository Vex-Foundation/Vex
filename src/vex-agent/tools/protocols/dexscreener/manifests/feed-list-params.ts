/**
 * The shared param vocabulary for the DexScreener FEED tools.
 *
 * Declared once and spread into each manifest, so `chainIds` cannot mean one thing
 * on `profiles` and another on `boosts`, and so the honest sentence each param must
 * carry is written in exactly one place.
 *
 * THE KEYS ARE DELIBERATELY THE SAME AS THE PAIR TOOLS'
 *
 * `limit`, `offset`, `fields`, `chainIds`, `sortBy`, `sortDir` mean here exactly
 * what they mean in `./pair-list-params.ts`, with the same validation. An agent
 * that learned `chainIds` on `dexscreener.search` must not have to learn a second
 * spelling to hunt, because having to remember which tool spells an idea which way
 * is the same bottleneck as having no filters at all — it just moves the cost from
 * call volume to guesswork.
 *
 * THE ONE SENTENCE EVERY PARAM HERE INHERITS
 *
 * DexScreener offers no server-side filter, sort, limit or pagination on any feed:
 * the whole API has one query parameter and it belongs to `search`. So every param
 * below subtracts from, orders, or narrows at most 30 rows DexScreener already
 * chose, and an empty result never means "this does not exist" — read
 * `droppedByFilter`.
 *
 * Profile feeds default to 20 because issuer text can exceed the agent output
 * budget; other feeds return their provider window. Applied defaults are echoed.
 */

import type { ProtocolParamDef } from "../../types.js";
import { EXPLAIN_DROPS_PARAM, STRING_OR_ARRAY_CLAUSE } from "./pair-list-params.js";

/**
 * Subtractive projection for the feed family — one name, and it is the big one.
 *
 * `description` is both the dominant byte cost of these payloads and their
 * entire hostile surface, and it is MANDATORY in a feed row, so this is the one
 * place in the namespace where subtraction does something `fields` cannot.
 */
export const FEED_OMIT_FIELDS_PARAM: ProtocolParamDef = {
  key: "omitFields",
  type: "string",
  description:
    "Comma-separated output fields to REMOVE from every row. Accepts one name: description — the "
    + "issuer-authored text that dominates these payloads (30 descriptions measured at 18,473 "
    + "characters on the recent-profiles feed) and carries the whole untrusted surface. Use it when "
    + "you want the chainId/tokenAddress identities and the feed's signal, and will resolve details "
    + "with dexscreener__token_pairs_list. Identity and signal fields are never omittable; everything else "
    + "is already opt-in via \"fields\", so there is nothing there to subtract. Echoed back as "
    + "fieldsOmitted, and externalContentFields reflects what actually remains.",
};

/** Repeated in the params that can silently mislead about coverage. */
const FEED_WINDOW_CLAUSE =
  "Applied by Vex to the at most 30 rows DexScreener returned — it cannot reach rows outside that "
  + "window, and an empty result means this window held none, not that none exist.";

/**
 * The same truth at TOOL level, for the `description` of the three fixed-window
 * feed tools (`profiles`, `boosts`, `ads`) across all five endpoints they read.
 *
 * It lives beside `FEED_WINDOW_CLAUSE` so the window fact still has exactly one
 * owner: a correction cannot land on the params and miss the descriptions, or on
 * four feeds and miss the fifth. `communityTakeovers` and `attention` are NOT on
 * this clause — the takeover feed has only an observed bound (28 rows measured,
 * never a stated cap) and `attention` merges two windows, so each states its own.
 */
export const FEED_DESCRIPTION_WINDOW_CLAUSE =
  "Every filter, sort and window is applied by Vex to the provider's own feed window of at most 30 "
  + "rows per call. DexScreener offers no server-side filter, sort, limit or pagination, and there "
  + "is no way to widen the window.";

/** Window / paging. Replaces every silent default. */
export const FEED_WINDOW_PARAMS: readonly ProtocolParamDef[] = [
  {
    key: "limit",
    type: "number",
    description:
      "Max rows to return (1-200). Profile feeds default to 20 to bound issuer-authored text; "
      + "other feeds return their provider window unless set. Any applied value is echoed in "
      + "filtersApplied.limit and hasMore tells whether this provider window has additional rows. "
      + "Use offset to read them. 0 is rejected because it cannot mean "
      + "both 'none' and 'all'.",
  },
  {
    key: "offset",
    type: "number",
    description:
      "Skip this many rows of the SAME provider window (default 0). It cannot reach rows beyond "
      + "DexScreener's 30 — there is no pagination on any feed.",
  },
  {
    key: "fields",
    type: "string",
    description:
      "Comma-separated extra output fields, ADDED to the default row (chainId and tokenAddress are "
      + "never projected away, and each feed's own signal fields are always emitted). Use 'full' "
      + "for every field — that is also how to discover the names, since a misspelled one is "
      + "rejected with the complete accepted list. Opt-in covers dexScreenerUrl, the issuer's link "
      + "list, and two CDN image URLs which are excluded by default because a model cannot see an "
      + "image and they were 5-7 KB of every call.",
  },
];

/** Sorting. */
export const FEED_SORT_PARAMS: readonly ProtocolParamDef[] = [
  {
    key: "sortBy",
    type: "string",
    description:
      "relevance | eventAgeSeconds | boostCount | boostCountTotal | adImpressionCount, restricted "
      + "per feed to the keys its rows actually carry — a key this feed cannot order by is rejected "
      + "naming the ones it can. 'relevance' means 'as DexScreener returned': its feed order is "
      + "undisclosed, is not a ranking and is not stable. eventAgeSeconds is seconds since the "
      + "event THIS feed reports (profile update, takeover claim, ad placement).",
  },
  {
    key: "sortDir",
    type: "string",
    description:
      "desc (default) or asc. Rows whose sort metric is unknown always sort last, in BOTH "
      + "directions — an unknown value is unranked, not smallest.",
  },
];

/** Chain filter. Meaningful on every feed: all six mix chains in one window. */
export const FEED_CHAIN_FILTER_PARAM: ProtocolParamDef = {
  key: "chainIds",
  type: "string",
  acceptsStringArray: true,
  description:
    "Comma-separated chain slugs to keep (e.g. base,solana,robinhood), matched case-insensitively. "
    + `${STRING_OR_ARRAY_CLAUSE} `
    + `${FEED_WINDOW_CLAUSE} Every feed mixes chains — one live window held base, solana, bsc, `
    + "pulsechain, ethereum, arbitrum, robinhood and berachain at once — so this is the filter that "
    + "makes a per-chain hunt possible at all. Read droppedByFilter.chainIds to see how much of the "
    + "window it removed.",
};

/**
 * Freshness on the profile tool, over both of its feeds.
 *
 * `updatedAt` is the only field in either feed from which freshness is
 * computable. Provider drift, measured live 2026-08-21: the recent-updates
 * feed still sends it 30/30; the latest feed stopped sending it entirely
 * (0/30), so this filter there excludes every row into
 * droppedByFilter.unknownEventAge - honest, but empty. The param stays on
 * both feeds because the filter semantics are identical and the provider may
 * restore the field; the description steers the model to the feed that works.
 */
export const PROFILE_FRESHNESS_PARAMS: readonly ProtocolParamDef[] = [
  {
    key: "updatedWithinSeconds",
    type: "number",
    description:
      "Keep profiles updated within this many seconds, computed from updatedAt against asOfMs and "
      + "reported as eventAgeSeconds on every row. Rows with no updatedAt are excluded and counted "
      + "in droppedByFilter.unknownEventAge — 'we cannot tell when' is a different answer from 'too "
      + "old'. The latest-profiles feed currently sends no updatedAt at all (provider drift, "
      + "measured 2026-08-21), so this filter there drops every row - read the recentUpdates feed "
      + "for freshness. Every response is edge-cached about 30s, so nothing here is real-time. "
      + "Whole number.",
  },
  {
    key: "ctoOnly",
    type: "boolean",
    description:
      "Keep only profiles flagged as a community takeover (the provider's cto field, emitted as "
      + "communityTakeover). Present on 30/30 rows of both profile feeds — 2 of 30 were true on one "
      + "live window, 0 of 30 on the other, so expect this to empty the result often. A row where "
      + "the feed sent no flag is UNKNOWN and is dropped, because the filter asks us to prove the "
      + "takeover. Rejected on any tool whose feed does not carry the flag.",
  },
];

/** Freshness on the takeover feed. */
export const TAKEOVER_FRESHNESS_PARAM: ProtocolParamDef = {
  key: "claimedWithinSeconds",
  type: "number",
  description:
    "Keep takeovers claimed within this many seconds, computed from claimDate against asOfMs and "
    + "reported as eventAgeSeconds. Rows with no claimDate are excluded and counted in "
    + "droppedByFilter.unknownEventAge. Whole number.",
};

/** Freshness on the ads feed. */
export const AD_FRESHNESS_PARAM: ProtocolParamDef = {
  key: "placedWithinSeconds",
  type: "number",
  description:
    "Keep ads placed within this many seconds, computed from the ad's date against asOfMs and "
    + "reported as eventAgeSeconds. Rows with no date are excluded and counted in "
    + "droppedByFilter.unknownEventAge. Whole number.",
};

/**
 * The boost-units threshold, on the two boost feeds and the attention merge.
 *
 * Named for the field it reads. It is NOT `minBoostCount`: `/token-boosts/top/v1`
 * omits the per-purchase `amount` on 30/30 rows, so a filter on that field would
 * drop every row of an entire feed, while `totalAmount` is present on 30/30 rows
 * of both.
 */
export const BOOST_THRESHOLD_PARAM: ProtocolParamDef = {
  key: "minBoostCountTotal",
  type: "number",
  description:
    "Keep rows with at least this many CUMULATIVE active boost units. These are counts of 12-24h "
    + "promotion packs and are NEVER a currency amount — observed values are exactly 10, 20, 30, "
    + "50, 100, 300 and 500. Reads boostCountTotal, not the per-purchase boostCount, which the top "
    + "feed omits on every row. Rows with no reported total are dropped and counted in "
    + "droppedByFilter; 0 is a genuine no-op. Whole number.",
};

/**
 * The feed selectors, added by the Batch 2 merges (owner decision D7).
 *
 * `dexscreener.profiles.recent` and `dexscreener.boosts.top` were retired into
 * their siblings: each pair had one row shape, one param set and one handler
 * shape, differing only in WHICH provider endpoint filled the rows. That
 * difference is a value, not a tool, and it stays visible here rather than
 * being folded away - the two endpoints of each pair genuinely differ in what
 * they populate, and the enum text is where the model reads that.
 */
export const PROFILE_FEED_SELECTOR_PARAM: ProtocolParamDef = {
  key: "feed",
  type: "string",
  enum: ["latest", "recentUpdates"],
  description:
    "Which profile endpoint to read (default latest). latest = /token-profiles/latest/v1, the "
    + "plain newest-profiles window; the provider currently sends NO updatedAt on it (drift "
    + "measured 2026-08-21), so rows there carry no age and updatedWithinSeconds drops all of "
    + "them. recentUpdates = /token-profiles/recent-updates/v1, the change feed of projects that "
    + "just refreshed their description/socials/branding; it still sends updatedAt on 30/30 rows, "
    + "so it is the one to ask for freshness or a time sort. It is a narrow recency SAMPLE (one "
    + "live window's oldest row measured about 85 minutes), never a survey of the last N hours, "
    + "and it is a live but undocumented API surface: if it changes the call fails with the real "
    + "reason rather than returning an empty success.",
};

export const BOOST_FEED_SELECTOR_PARAM: ProtocolParamDef = {
  key: "feed",
  type: "string",
  enum: ["latest", "top"],
  description:
    "Which boost endpoint to read (default latest). latest = /token-boosts/latest/v1, the most "
    + "recent boost PURCHASES, carrying both the per-purchase boostCount and the cumulative "
    + "boostCountTotal. top = /token-boosts/top/v1, the tokens holding the most active boosts, "
    + "where boostCount is null on every row (the provider omits it) and only boostCountTotal is "
    + "readable; sortBy defaults to boostCountTotal there instead of relevance. Neither feed "
    + "carries a timestamp of any kind.",
};

/** Every feed's shared set, in the order an agent reads it. */
export const FEED_LIST_PARAMS: readonly ProtocolParamDef[] = [
  ...FEED_WINDOW_PARAMS,
  FEED_OMIT_FIELDS_PARAM,
  ...FEED_SORT_PARAMS,
  FEED_CHAIN_FILTER_PARAM,
  EXPLAIN_DROPS_PARAM,
];

/** `profiles`, over both profile endpoints. */
export const PROFILE_FEED_PARAMS: readonly ProtocolParamDef[] = [
  PROFILE_FEED_SELECTOR_PARAM,
  ...FEED_LIST_PARAMS,
  ...PROFILE_FRESHNESS_PARAMS,
];

/** `boosts`, over both boost endpoints. */
export const BOOST_FEED_PARAMS: readonly ProtocolParamDef[] = [
  BOOST_FEED_SELECTOR_PARAM,
  ...FEED_LIST_PARAMS,
  BOOST_THRESHOLD_PARAM,
];

/** `communityTakeovers`. */
export const TAKEOVER_FEED_PARAMS: readonly ProtocolParamDef[] = [
  ...FEED_LIST_PARAMS,
  TAKEOVER_FRESHNESS_PARAM,
];

/** `ads`. */
export const AD_FEED_PARAMS: readonly ProtocolParamDef[] = [
  ...FEED_LIST_PARAMS,
  AD_FRESHNESS_PARAM,
];

/**
 * `attention` — the synthetic profiles×boosts merge.
 *
 * No freshness param: the merge keeps boost units and drops the profile half's
 * `updatedAt`, so there is no timestamp on a merged row to filter. Declaring one
 * would be a filter that could only ever drop everything.
 */
export const ATTENTION_FEED_PARAMS: readonly ProtocolParamDef[] = [
  ...FEED_LIST_PARAMS,
  BOOST_THRESHOLD_PARAM,
];
