import type { ProtocolToolManifest } from "../../types.js";
import { SOLANA_CORE_DISCOVERY } from "../../embeddings/solana-jupiter/core.js";

export const CORE_TOOLS: readonly ProtocolToolManifest[] = [
  {
    toolId: "solana.prices",
    publicName: "solana__token_prices_get",
    namespace: "solana",
    lifecycle: "active",
    description: "Get real-time USD prices for one or more Solana token mints. Use this when you already know WHICH tokens you want priced and need nothing else about them - pass raw mint addresses via mints, or symbols, names or mints via queries, which are resolved for you with no separate lookup call first. Returns `prices` on the mints branch and `resolved` plus `raw` on the queries branch, and on both a `missing` list naming every mint or query Jupiter could not price, so an unpriceable token is disclosed rather than silently dropped. Exactly one of mints or queries: both is refused, neither is refused.",
    mutating: false,
    actionKind: "read",
    params: [
      { key: "mints", type: "string", description: "Comma-separated mint addresses. Provide this OR queries, not both." },
      { key: "queries", type: "string", description: "Comma-separated token symbols, names, or mint addresses to resolve and price (e.g. \"SOL,BONK\"). Provide this OR mints, not both." },
    ],
    exampleParams: { mints: "So11111111111111111111111111111111111111112" },
    // Exactly one, per the handler: both is refused, neither is refused. The
    // boundary now says it before the call instead of after it.
    exclusiveParamGroups: [["mints", "queries"]],
    requiresEnv: "JUPITER_API_KEY",
    discovery: SOLANA_CORE_DISCOVERY["solana.prices"],
  },
  {
    toolId: "solana.tokens.search",
    publicName: "solana__tokens_search",
    namespace: "solana",
    lifecycle: "active",
    description: "Look up SPECIFIC Solana tokens you can already name - by symbol, name, or up to 100 comma-separated mint addresses for a batch lookup. Use this when the user names a token and you need to know what it is and whether it is safe to touch; solana__tokens_discover is the surface when there is no name yet and the user wants what is new, popular or top-moving. Returns one projected row per matching token: identity, price, market cap and liquidity, holder and organic-trading signals, the safety-audit flags, tags and launchpad, and age - the ~40-field provider payload narrowed to what a trading decision uses, with every matching row kept. minOrganicScore, verifiedOnly and minLiquidity filter the result and an out-of-range value is rejected rather than clamped. The rows are the whole answer; there is no continuation to page through.",
    mutating: false,
    actionKind: "read",
    params: [
      { key: "query", type: "string", required: true, description: "Token name, symbol, or mint address. Accepts a comma-separated list of mint addresses (up to 100) for batch lookup." },
      { key: "statsInterval", type: "string", enum: ["5m", "1h", "6h", "24h", "all"], description: "Which stats window to include per token: 5m, 1h, 6h, or 24h, or all for every window (default: 1h)." },
      { key: "minOrganicScore", type: "number", description: "Only include tokens with organicScore >= this value (0-100). Rejected if out of range." },
      { key: "verifiedOnly", type: "boolean", description: "Only include Jupiter-verified tokens." },
      { key: "minLiquidity", type: "number", description: "Only include tokens with liquidity (USD) >= this value. Rejected if negative." },
    ],
    exampleParams: { query: "BONK" },
    requiresEnv: "JUPITER_API_KEY",
    discovery: SOLANA_CORE_DISCOVERY["solana.tokens.search"],
  },
  {
    toolId: "solana.tokens.trending",
    publicName: "solana__tokens_discover",
    namespace: "solana",
    lifecycle: "active",
    description: "Discover Solana tokens without already knowing a name - freshly launched/new (recent), trending, top-traded, top-organic, verified, tokenized stocks, or liquid staking. THE fastest fresh-token surface on Solana: category=recent measured live (2026-08-17) at 30 rows spanning ages 10-175 SECONDS since mint, every row carrying createdAt as proof of age - where DexScreener's feeds reached ~16 minutes at best. createdAt is provider-optional, so treat a null as unknown age, never as fresh. Use this when the user wants what is NEW, hot or heavily traded on Solana and cannot name a token yet; solana__tokens_search is the lookup once a symbol, name or mint is known. Returns an accounted window: `tokens`, one projected row each (identity, price, market cap and liquidity, holder and organic-trading signals, the safety-audit flags, tags and launchpad, age), alongside `returned`, `totalMatched` and `hasMore`, so a trimmed result always says so - a bare recent call measured 27,970 B, so limit is applied Vex-side and never silently. Richer signal (organic score, verification, holder data, audit flags) than generic feeds.",
    mutating: false,
    actionKind: "read",
    params: [
      { key: "category", type: "string", enum: ["toptrending", "toptraded", "toporganicscore", "recent", "lst", "verified", "stocks"], description: "Category: recent (freshly launched tokens, newest first - measured live: ages 10-175 s since mint, createdAt on every row; use for brand-new/fresh tokens), toptrending (most price movement), toptraded (highest volume), toporganicscore (highest real/organic activity), verified (Jupiter-verified), lst (liquid staking), stocks (tokenized equities, e.g. Ondo, Remora)." },
      { key: "interval", type: "string", enum: ["5m", "1h", "6h", "24h"], description: "Time interval: 5m, 1h, 6h, 24h." },
      { key: "limit", type: "number", description: "Max rows returned (default 20). Server-side for the top* categories; applied Vex-side for recent/lst/verified/stocks with returned/totalMatched/hasMore accounting - nothing is silently dropped." },
      { key: "statsInterval", type: "string", enum: ["5m", "1h", "6h", "24h", "all"], description: "Which stats window to include per token: 5m, 1h, 6h, or 24h, or all for every window (default: same as interval, or 1h)." },
      { key: "minOrganicScore", type: "number", description: "Only include tokens with organicScore >= this value (0-100). Rejected if out of range." },
      { key: "verifiedOnly", type: "boolean", description: "Only include Jupiter-verified tokens." },
      { key: "minLiquidity", type: "number", description: "Only include tokens with liquidity (USD) >= this value. Rejected if negative." },
    ],
    exampleParams: { category: "toptrending", interval: "1h", limit: 10 },
    requiresEnv: "JUPITER_API_KEY",
    discovery: SOLANA_CORE_DISCOVERY["solana.tokens.trending"],
  },
];
