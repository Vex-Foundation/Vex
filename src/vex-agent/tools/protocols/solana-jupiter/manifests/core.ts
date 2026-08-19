import type { ProtocolToolManifest } from "../../types.js";
import { SOLANA_CORE_DISCOVERY } from "../../embeddings/solana-jupiter/core.js";

export const CORE_TOOLS: readonly ProtocolToolManifest[] = [
  {
    toolId: "solana.prices",
    namespace: "solana",
    lifecycle: "active",
    description: "Get real-time USD prices for one or more Solana token mints — pass raw mint addresses via mints, OR symbols/names/mints via queries (resolved automatically, no separate lookup tool needed first). Returns each requested id's price (under prices, or resolved for queries); any mint/query Jupiter could not price is listed in missing instead of being silently dropped.",
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
    namespace: "solana",
    lifecycle: "active",
    description: "Search for or look up one or more SPECIFIC Solana tokens you can already name — by symbol, name, or mint address (up to 100 comma-separated mints for a batch lookup) — for identity, price, market cap, liquidity, holder count, and safety-audit flags. Use solana.tokens.trending instead when you don't have a name yet and want to discover new, popular, or top-moving tokens.",
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
    namespace: "solana",
    lifecycle: "active",
    description: "Discover Solana tokens without already knowing a name — freshly launched/new (recent), trending, top-traded, top-organic, verified, tokenized stocks, or liquid staking. THE fastest fresh-token surface on Solana: category=recent measured live (2026-08-17) at 30 rows spanning ages 10-175 SECONDS since mint, every row carrying createdAt as proof of age — where DexScreener's feeds reached ~16 minutes at best. createdAt is provider-optional, so treat a null as unknown age, never as fresh. The response is an accounted window: returned/totalMatched/hasMore plus tokens (a bare recent call measured 27,970 B against the 16,384 B tool-output cap, so limit is applied Vex-side and never silently). Richer signal (organic score, verification, holder data, audit flags) than generic feeds. Use solana.tokens.search instead once you already have a specific symbol, name, or mint to look up.",
    mutating: false,
    actionKind: "read",
    params: [
      { key: "category", type: "string", enum: ["toptrending", "toptraded", "toporganicscore", "recent", "lst", "verified", "stocks"], description: "Category: recent (freshly launched tokens, newest first — measured live: ages 10-175 s since mint, createdAt on every row; use for brand-new/fresh tokens), toptrending (most price movement), toptraded (highest volume), toporganicscore (highest real/organic activity), verified (Jupiter-verified), lst (liquid staking), stocks (tokenized equities, e.g. Ondo, Remora)." },
      { key: "interval", type: "string", enum: ["5m", "1h", "6h", "24h"], description: "Time interval: 5m, 1h, 6h, 24h." },
      { key: "limit", type: "number", description: "Max rows returned (default 20). Server-side for the top* categories; applied Vex-side for recent/lst/verified/stocks with returned/totalMatched/hasMore accounting — nothing is silently dropped." },
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
