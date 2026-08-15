/**
 * Manifests for the feed / attention / narrative tools.
 *
 * The tool-level `description` strings carry the same honest constraints as the
 * PARAM text in `./feed-list-params.ts` and `./narrative-list-params.ts`: what
 * window the provider chose, that every filter and sort is ours, and that the
 * window cannot be widened. Each family's bound differs and is measured, not
 * assumed — the five fixed feeds share `FEED_DESCRIPTION_WINDOW_CLAUSE`, while
 * `communityTakeovers`, `attention`, `trending` and `meta` state their own.
 *
 * Every tool here declared ZERO params (one on `attention`, with a silent default
 * of 20) until this card. `exampleParams` are the shape of a real hunting call, not
 * a minimal one, because the example is the fastest thing an agent reads.
 */

import type { ProtocolToolManifest } from "../../types.js";
import { DEXSCREENER_TRENDING_DISCOVERY } from "../../embeddings/dexscreener/trending.js";
import { PAIR_LIST_PARAMS, SEARCH_CHAIN_FILTER_PARAM } from "./pair-list-params.js";
import {
  AD_FEED_PARAMS,
  ATTENTION_FEED_PARAMS,
  BOOST_FEED_PARAMS,
  FEED_DESCRIPTION_WINDOW_CLAUSE,
  PROFILE_FEED_PARAMS,
  TAKEOVER_FEED_PARAMS,
} from "./feed-list-params.js";
import { NARRATIVE_LIST_PARAMS } from "./narrative-list-params.js";

export const TRENDING_TOOLS: readonly ProtocolToolManifest[] = [
  {
    toolId: "dexscreener.profiles",
    namespace: "dexscreener",
    lifecycle: "active",
    description:
      "Get the latest token-profile listings on DEX Screener — icons, descriptions, social links, "
      + "and each profile's updatedAt timestamp. Keep one or more chains with chainIds and bound "
      + "freshness with updatedWithinSeconds. "
      + FEED_DESCRIPTION_WINDOW_CLAUSE,
    mutating: false,
    actionKind: "read",
    params: [...PROFILE_FEED_PARAMS],
    exampleParams: { chainIds: "solana", updatedWithinSeconds: 3600, limit: 15 },
    discovery: DEXSCREENER_TRENDING_DISCOVERY["dexscreener.profiles"],
  },
  {
    toolId: "dexscreener.profiles.recent",
    namespace: "dexscreener",
    lifecycle: "active",
    description:
      "Get RECENTLY UPDATED token profiles — projects that just refreshed their "
      + "description/socials/branding, each with an updatedAt timestamp and a community-takeover "
      + "flag (emitted as communityTakeover). A change feed vs the plain latest-profiles list. "
      + FEED_DESCRIPTION_WINDOW_CLAUSE
      + " Live but undocumented API surface — may change; if it does the call fails with the real "
      + "reason (rate limit, transport, or unreadable payload), it does not return an empty success.",
    mutating: false,
    actionKind: "read",
    params: [...PROFILE_FEED_PARAMS],
    exampleParams: { chainIds: "base", limit: 15 },
    discovery: DEXSCREENER_TRENDING_DISCOVERY["dexscreener.profiles.recent"],
  },
  {
    toolId: "dexscreener.boosts",
    namespace: "dexscreener",
    lifecycle: "active",
    description:
      "Get latest boosted/promoted tokens with boost amounts. Paid visibility signal — shows where "
      + "money is being spent on promotion. "
      + FEED_DESCRIPTION_WINDOW_CLAUSE,
    mutating: false,
    actionKind: "read",
    params: [...BOOST_FEED_PARAMS],
    exampleParams: { chainIds: "solana", minBoostCountTotal: 50, sortBy: "boostCountTotal" },
    discovery: DEXSCREENER_TRENDING_DISCOVERY["dexscreener.boosts"],
  },
  {
    toolId: "dexscreener.boosts.top",
    namespace: "dexscreener",
    lifecycle: "active",
    description:
      "Get tokens with most active boosts (top promoted), ranked by totalAmount (cumulative active "
      + "boost units). This feed reports no per-purchase amount — that field is null here; use "
      + "dexscreener.boosts for latest-purchase amounts. "
      + FEED_DESCRIPTION_WINDOW_CLAUSE,
    mutating: false,
    actionKind: "read",
    params: [...BOOST_FEED_PARAMS],
    exampleParams: { sortBy: "boostCountTotal", limit: 10 },
    discovery: DEXSCREENER_TRENDING_DISCOVERY["dexscreener.boosts.top"],
  },
  {
    toolId: "dexscreener.communityTakeovers",
    namespace: "dexscreener",
    lifecycle: "active",
    description:
      "Get the latest rows carrying DexScreener's community-takeover (CTO) label. This provider "
      + "classification is not proof that ownership, admin keys, or contract control changed. Each "
      + "row carries the provider's claimDate (emitted as claimedAt, reported as "
      + "eventAgeSeconds); bound recency with claimedWithinSeconds. This is a RECENCY WINDOW, not a "
      + "takeover history: it reports the takeovers this feed is carrying right now, so 'has token X "
      + "ever had a CTO' and 'list this token's past takeovers' are NOT answerable here or anywhere "
      + "in this API — a token absent from the window has not been shown to lack a takeover. For a "
      + "per-token flag use dexscreener.profiles / dexscreener.profiles.recent, whose rows carry "
      + "communityTakeover. Every filter, sort and window is "
      + "applied by Vex to the provider's returned feed window (observed ≤30 rows). DexScreener "
      + "offers no server-side filter, sort, limit or pagination, and there is no way to widen the "
      + "window.",
    mutating: false,
    actionKind: "read",
    params: [...TAKEOVER_FEED_PARAMS],
    exampleParams: { claimedWithinSeconds: 86400, sortBy: "eventAgeSeconds", sortDir: "asc" },
    discovery: DEXSCREENER_TRENDING_DISCOVERY["dexscreener.communityTakeovers"],
  },
  {
    toolId: "dexscreener.attention",
    namespace: "dexscreener",
    lifecycle: "active",
    description:
      "Synthetic ATTENTION signal — merges token-profiles + paid boosts into one ranked, "
      + "deduplicated list (boost spend, then profile presence). Shows which specific tokens are "
      + "buying visibility. This is NOT the official trending feed — use dexscreener.trending for "
      + "trending narratives. It is a Vex-side merge of the token-profile and paid-boost feed "
      + "windows (each ≤30 provider-chosen rows, so the merge can reach ~60 rows); every filter, "
      + "sort and window is applied by Vex; no server-side options exist and the underlying windows "
      + "cannot be widened. ROWS CARRY NO TIMESTAMP and none can be added: the boost feed publishes "
      + "no time of any kind, and the merge keeps boost units rather than the profile half's "
      + "updatedAt — so nothing here can be filtered or sorted by age, and a row being present says "
      + "nothing about when it appeared. Use dexscreener.profiles.recent when you need a "
      + "time-ordered feed.",
    mutating: false,
    actionKind: "read",
    params: [...ATTENTION_FEED_PARAMS],
    exampleParams: { minBoostCountTotal: 30, limit: 20 },
    discovery: DEXSCREENER_TRENDING_DISCOVERY["dexscreener.attention"],
  },
  {
    toolId: "dexscreener.trending",
    namespace: "dexscreener",
    lifecycle: "active",
    description:
      "Live, undocumented DEX Screener TRENDING NARRATIVES feed — themes/metas (AI, dogs, 'knockoff "
      + "legends', …) with aggregate market cap, liquidity, 24h volume, token count, and one "
      + "market-cap change field, marketCapChangePctSelected, resolved against the `window` param "
      + "(default h24). Returns NARRATIVES, not individual tokens; drill into one with "
      + "dexscreener.meta. Every filter, sort and window is applied by Vex to the provider's current "
      + "trending list, whose size the provider chooses (19 narratives in current captures). No "
      + "server-side filter, sort, limit or pagination exists. Live but undocumented API surface — "
      + "may change; if it does the call fails with the real reason (rate limit, transport, or "
      + "unreadable payload), it does not return an empty success.",
    mutating: false,
    actionKind: "read",
    params: [...NARRATIVE_LIST_PARAMS],
    exampleParams: { sortBy: "marketCapChangePct", window: "h6", minTokenCount: 10 },
    discovery: DEXSCREENER_TRENDING_DISCOVERY["dexscreener.trending"],
  },
  {
    toolId: "dexscreener.meta",
    namespace: "dexscreener",
    lifecycle: "active",
    description:
      "Drill into ONE trending narrative/meta by slug (from dexscreener.trending, e.g. "
      + "'knockoff-legends') — returns the narrative's aggregate stats plus the DEX pairs inside it. "
      + "Each pair's raw priceUsd always prices its base token. The slug is a NARRATIVE slug, never "
      + "a chain slug. Returns 20 pair rows by default and exposes the rest through hasMore and "
      + "offset. Every filter, sort and window is applied "
      + "by Vex to the pairs the provider returns for that narrative — the set can exceed 30 rows "
      + "(31 observed). No server-side filter, sort, limit or pagination exists. Live but "
      + "undocumented API surface — may change; if it does the call fails with the real reason (rate "
      + "limit, transport, or unreadable payload), it does not return an empty success.",
    mutating: false,
    actionKind: "read",
    params: [
      { key: "slug", type: "string", required: true, description: "Narrative slug from dexscreener.trending results (e.g. 'ai', 'dog', 'knockoff-legends'). NOT a chain slug." },
      SEARCH_CHAIN_FILTER_PARAM,
      ...PAIR_LIST_PARAMS,
    ],
    exampleParams: { slug: "cat", chainIds: "solana", minTurnoverRatio: 0.05 },
    discovery: DEXSCREENER_TRENDING_DISCOVERY["dexscreener.meta"],
  },
];
