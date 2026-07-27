import type { ProtocolToolManifest } from "../../types.js";
import { DEXSCREENER_TRENDING_DISCOVERY } from "../../embeddings/dexscreener/trending.js";

export const TRENDING_TOOLS: readonly ProtocolToolManifest[] = [
  {
    toolId: "dexscreener.profiles",
    namespace: "dexscreener",
    lifecycle: "active",
    description: "Get latest trending token profiles — icons, descriptions, social links. Shows what projects are gaining attention.",
    mutating: false,
    actionKind: "read",
    params: [],
    exampleParams: {},
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
    params: [],
    exampleParams: {},
    discovery: DEXSCREENER_TRENDING_DISCOVERY["dexscreener.profiles.recent"],
  },
  {
    toolId: "dexscreener.boosts",
    namespace: "dexscreener",
    lifecycle: "active",
    description: "Get latest boosted/promoted tokens with boost amounts. Paid visibility signal — shows where money is being spent on promotion.",
    mutating: false,
    actionKind: "read",
    params: [],
    exampleParams: {},
    discovery: DEXSCREENER_TRENDING_DISCOVERY["dexscreener.boosts"],
  },
  {
    toolId: "dexscreener.boosts.top",
    namespace: "dexscreener",
    lifecycle: "active",
    description: "Get tokens with most active boosts (top promoted), ranked by totalAmount (cumulative active boost units). This feed reports no per-purchase amount — that field is null here; use dexscreener.boosts for latest-purchase amounts.",
    mutating: false,
    actionKind: "read",
    params: [],
    exampleParams: {},
    discovery: DEXSCREENER_TRENDING_DISCOVERY["dexscreener.boosts.top"],
  },
  {
    toolId: "dexscreener.communityTakeovers",
    namespace: "dexscreener",
    lifecycle: "active",
    description: "Get latest community takeover (CTO) events — tokens where community reclaimed control. Strong trading signal, often precedes price action.",
    mutating: false,
    actionKind: "read",
    params: [],
    exampleParams: {},
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
    params: [
      { key: "limit", type: "number", description: "Max results to return (default 20)." },
    ],
    exampleParams: { limit: 20 },
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
    params: [
      { key: "limit", type: "number", description: "Max narratives to return. Omit to return all." },
    ],
    exampleParams: { limit: 20 },
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
    ],
    exampleParams: { slug: "knockoff-legends" },
    discovery: DEXSCREENER_TRENDING_DISCOVERY["dexscreener.meta"],
  },
];
