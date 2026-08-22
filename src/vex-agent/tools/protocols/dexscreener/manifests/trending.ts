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
import { PAIR_LIST_PARAMS, SEARCH_CHAIN_FILTER_PARAM, SOURCE_OBSERVATION_CLAUSE } from "./pair-list-params.js";
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
    publicName: "dexscreener__profiles_list",
    namespace: "dexscreener",
    lifecycle: "active",
    description:
      "Read DEX Screener token PROFILE METADATA - icons, descriptions, social links, and the "
      + "community-takeover flag (emitted as communityTakeover) - from either profile endpoint. "
      + "Use feed: latest (default) for the plain newest-profiles window, or feed: recentUpdates "
      + "for the change feed of projects that just refreshed their branding, which is the one "
      + "carrying updatedAt and therefore the one to use when the question is about freshness or "
      + "a time order. A profile update is metadata, NOT token creation: neither feed says when a "
      + "token or pair was created, and young pools surface here through marketing activity "
      + "rather than a launch record. The latest feed currently sends no updatedAt at all (drift "
      + "measured 2026-08-21), so updatedWithinSeconds there drops every row into "
      + "droppedByFilter.unknownEventAge; recentUpdates still sends it on 30/30 rows and is a "
      + "narrow recency SAMPLE (oldest row about 85 minutes in one live window), never a survey "
      + "of the last N hours. Keep one or more chains with chainIds. RETURNS one row per profile: "
      + "chainId, tokenAddress, description, communityTakeover, eventAgeSeconds where the feed "
      + "carries a time, plus the provenance envelope (filtersApplied, droppedByFilter, hasMore) "
      + "and the endpoint each row came from. recentUpdates is a live but undocumented API "
      + "surface - if it changes the call fails with the real reason (rate limit, transport, or "
      + "unreadable payload), it does not return an empty success. "
      + FEED_DESCRIPTION_WINDOW_CLAUSE + " " + SOURCE_OBSERVATION_CLAUSE,
    mutating: false,
    actionKind: "read",
    params: [...PROFILE_FEED_PARAMS],
    exampleParams: { feed: "recentUpdates", chainIds: "solana", updatedWithinSeconds: 3600, limit: 15 },
    discovery: DEXSCREENER_TRENDING_DISCOVERY["dexscreener.profiles"],
  },
  {
    toolId: "dexscreener.boosts",
    publicName: "dexscreener__boosts_list",
    namespace: "dexscreener",
    lifecycle: "active",
    description:
      "Read DEX Screener's paid-boost feeds - where promotion is being BOUGHT - from either boost "
      + "endpoint. Use this when the question is who is paying for visibility right now, which "
      + "tokens are holding the most active promotion, or whether a token you already found is "
      + "being boosted. Use feed: latest (default) for the most recent boost PURCHASES, which carry "
      + "both the per-purchase boostCount and the cumulative boostCountTotal, or feed: top for "
      + "the tokens holding the most active boosts, where boostCount is null on every row (the "
      + "provider omits it), only boostCountTotal is readable, and sortBy defaults to "
      + "boostCountTotal. Boost figures are provider promotion units (12-24h packs), never a "
      + "currency amount, and paid promotion is never demand, legitimacy, or safety. Neither feed "
      + "carries a timestamp of any kind, so nothing here can be filtered or sorted by age. "
      + "RETURNS one row per boosted token: chainId, tokenAddress, boostCount, boostCountTotal, "
      + "description, plus the provenance envelope (filtersApplied, droppedByFilter, skippedRows, "
      + "hasMore) and the endpoint the rows came from. "
      + FEED_DESCRIPTION_WINDOW_CLAUSE + " " + SOURCE_OBSERVATION_CLAUSE,
    mutating: false,
    actionKind: "read",
    params: [...BOOST_FEED_PARAMS],
    exampleParams: { feed: "top", chainIds: "solana", minBoostCountTotal: 50, limit: 10 },
    discovery: DEXSCREENER_TRENDING_DISCOVERY["dexscreener.boosts"],
  },
  {
    toolId: "dexscreener.communityTakeovers",
    publicName: "dexscreener__community_takeovers_list",
    namespace: "dexscreener",
    lifecycle: "active",
    description:
      "Get the latest rows carrying DexScreener's community-takeover (CTO) label. Use this when "
      + "the user asks which tokens have just been marked as community takeovers, or wants the "
      + "current CTO-labelled window as a starting list. This provider "
      + "classification is not proof that ownership, admin keys, or contract control changed. Each "
      + "row carries the provider's claimDate (emitted as claimedAt, reported as "
      + "eventAgeSeconds); bound recency with claimedWithinSeconds. This is a RECENCY WINDOW, not a "
      + "takeover history: it reports the takeovers this feed is carrying right now, so 'has token X "
      + "ever had a CTO' and 'list this token's past takeovers' are NOT answerable here or anywhere "
      + "in this API — a token absent from the window has not been shown to lack a takeover. For a "
      + "per-token flag use dexscreener__profiles_list (either feed), whose rows carry "
      + "communityTakeover. Nothing in this namespace establishes contract safety - use a "
      + "dedicated chain safety tool for contract risk. RETURNS one row per labelled token: "
      + "chainId, tokenAddress, description, claimedAt and eventAgeSeconds, plus the provenance "
      + "envelope (filtersApplied, droppedByFilter, totalMatched, returned, offset, hasMore). "
      + "Every filter, sort and window is "
      + "applied by Vex to the provider's returned feed window (observed ≤30 rows). DexScreener "
      + "offers no server-side filter, sort, limit or pagination, and there is no way to widen the "
      + "window." + " " + SOURCE_OBSERVATION_CLAUSE,
    mutating: false,
    actionKind: "read",
    params: [...TAKEOVER_FEED_PARAMS],
    exampleParams: { claimedWithinSeconds: 86400, sortBy: "eventAgeSeconds", sortDir: "asc" },
    discovery: DEXSCREENER_TRENDING_DISCOVERY["dexscreener.communityTakeovers"],
  },
  {
    toolId: "dexscreener.attention",
    publicName: "dexscreener__attention_list",
    namespace: "dexscreener",
    lifecycle: "active",
    description:
      "Vex's SYNTHETIC merge of token-profiles + paid boosts into one ranked, deduplicated list "
      + "(boost spend, then profile presence). Use this when the user explicitly asks for the "
      + "combined profile-plus-boost view, and only then. RETURNS one merged row per token: "
      + "chainId, tokenAddress, description, boostCount, boostCountTotal and hasProfile, plus the "
      + "provenance envelope (filtersApplied, droppedByFilter, skippedBoostRows, totalMatched, "
      + "returned, offset, hasMore). It is not a provider feed and not an organic or "
      + "genuine attention signal - for trending narratives use dexscreener__narratives_list, for paid "
      + "visibility alone use dexscreener__boosts_list. It is a Vex-side merge of the token-profile and paid-boost feed "
      + "windows (each ≤30 provider-chosen rows, so the merge can reach ~60 rows); every filter, "
      + "sort and window is applied by Vex; no server-side options exist and the underlying windows "
      + "cannot be widened. ROWS CARRY NO TIMESTAMP and none can be added: the boost feed publishes "
      + "no time of any kind, and the merge keeps boost units rather than the profile half's "
      + "updatedAt — so nothing here can be filtered or sorted by age, and a row being present says "
      + "nothing about when it appeared. Use dexscreener__profiles_list with feed: recentUpdates when "
      + "you need a time-ordered feed." + " " + SOURCE_OBSERVATION_CLAUSE,
    mutating: false,
    actionKind: "read",
    params: [...ATTENTION_FEED_PARAMS],
    exampleParams: { minBoostCountTotal: 30, limit: 20 },
    discovery: DEXSCREENER_TRENDING_DISCOVERY["dexscreener.attention"],
  },
  {
    toolId: "dexscreener.trending",
    publicName: "dexscreener__narratives_list",
    namespace: "dexscreener",
    lifecycle: "active",
    description:
      "Live, undocumented DEX Screener TRENDING NARRATIVES feed — themes/metas (AI, dogs, 'knockoff "
      + "legends', …) with aggregate market cap, liquidity, 24h volume, token count, and one "
      + "market-cap change field, marketCapChangePctSelected, resolved against the `window` param "
      + "(default h24). Use this when the user asks what themes or metas the market is rotating "
      + "into, or wants a narrative-level starting point before naming any token. Returns "
      + "NARRATIVES, not individual tokens; drill into one with "
      + "dexscreener__narrative_get. Every filter, sort and window is applied by Vex to the provider's current "
      + "trending list, whose size the provider chooses (19 narratives in current captures). No "
      + "server-side filter, sort, limit or pagination exists. Live but undocumented API surface — "
      + "may change; if it does the call fails with the real reason (rate limit, transport, or "
      + "unreadable payload), it does not return an empty success." + " " + SOURCE_OBSERVATION_CLAUSE,
    mutating: false,
    actionKind: "read",
    params: [...NARRATIVE_LIST_PARAMS],
    exampleParams: { sortBy: "marketCapChangePct", window: "h6", minTokenCount: 10 },
    discovery: DEXSCREENER_TRENDING_DISCOVERY["dexscreener.trending"],
  },
  {
    toolId: "dexscreener.meta",
    publicName: "dexscreener__narrative_get",
    namespace: "dexscreener",
    lifecycle: "active",
    description:
      "Drill into ONE trending narrative/meta by slug (from dexscreener__narratives_list, e.g. "
      + "'knockoff-legends') — returns the narrative's aggregate stats plus the DEX pairs inside it. "
      + "Use this when you already have a narrative slug and want the tokens trading inside it. "
      + "Each pair's raw priceUsd always prices its base token. The slug is a NARRATIVE slug, never "
      + "a chain slug. Returns 20 pair rows by default and exposes the rest through hasMore and "
      + "offset. Every filter, sort and window is applied "
      + "by Vex to the pairs the provider returns for that narrative — the set can exceed 30 rows "
      + "(31 observed). No server-side filter, sort, limit or pagination exists. Live but "
      + "undocumented API surface — may change; if it does the call fails with the real reason (rate "
      + "limit, transport, or unreadable payload), it does not return an empty success." + " " + SOURCE_OBSERVATION_CLAUSE,
    mutating: false,
    actionKind: "read",
    params: [
      { key: "slug", type: "string", required: true, description: "Narrative slug from dexscreener__narratives_list results (e.g. 'ai', 'dog', 'knockoff-legends'). NOT a chain slug." },
      SEARCH_CHAIN_FILTER_PARAM,
      ...PAIR_LIST_PARAMS,
    ],
    exampleParams: { slug: "cat", chainIds: "solana", minTurnoverRatio: 0.05 },
    discovery: DEXSCREENER_TRENDING_DISCOVERY["dexscreener.meta"],
  },
];
