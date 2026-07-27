/**
 * Manifests for the feed / attention / narrative tools.
 *
 * The tool-level `description` strings below predate the param work and are owned
 * by a separate description card — the PARAM text is where the honest constraints
 * live for now, in `./feed-list-params.ts` and `./narrative-list-params.ts`.
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
  PROFILE_FEED_PARAMS,
  TAKEOVER_FEED_PARAMS,
} from "./feed-list-params.js";
import { NARRATIVE_LIST_PARAMS } from "./narrative-list-params.js";

export const TRENDING_TOOLS: readonly ProtocolToolManifest[] = [
  {
    toolId: "dexscreener.profiles",
    namespace: "dexscreener",
    lifecycle: "active",
    description: "Get latest trending token profiles — icons, descriptions, social links. Shows what projects are gaining attention.",
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
      "Get RECENTLY UPDATED token profiles — projects that just refreshed their description/socials/branding, each with an updatedAt timestamp and a community-takeover (cto) flag. A change feed vs the plain latest-profiles list. Live but undocumented API surface — may change; if it does the call fails with the real reason (rate limit, transport, or unreadable payload), it does not return an empty success.",
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
    description: "Get latest boosted/promoted tokens with boost amounts. Paid visibility signal — shows where money is being spent on promotion.",
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
    description: "Get tokens with most active boosts (top promoted), ranked by totalAmount (cumulative active boost units). This feed reports no per-purchase amount — that field is null here; use dexscreener.boosts for latest-purchase amounts.",
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
    description: "Get latest community takeover (CTO) events — tokens where community reclaimed control. Strong trading signal, often precedes price action.",
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
      "Synthetic ATTENTION signal — merges token-profiles + paid boosts into one ranked, deduplicated list (boost spend, then profile presence). Shows which specific tokens are buying visibility. This is NOT the official trending feed — use dexscreener.trending for trending narratives.",
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
      "Official DEX Screener TRENDING NARRATIVES feed — trending themes/metas (AI, dogs, 'knockoff legends', …) with aggregate market cap, liquidity, 24h volume, token count, and market-cap change windows. Returns NARRATIVES, not individual tokens; drill into one with dexscreener.meta. Live but undocumented API surface — may change; if it does the call fails with the real reason (rate limit, transport, or unreadable payload), it does not return an empty success.",
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
      "Drill into ONE trending narrative/meta by slug (from dexscreener.trending, e.g. 'knockoff-legends') — returns the narrative's aggregate stats plus the DEX pairs inside it. The slug is a NARRATIVE slug, never a chain slug. Live but undocumented API surface — may change; if it does the call fails with the real reason (rate limit, transport, or unreadable payload), it does not return an empty success.",
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
