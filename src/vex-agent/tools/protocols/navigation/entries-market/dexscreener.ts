import type { ProtocolNamespaceNavigation } from "../types.js";

export const DEXSCREENER_NAVIGATION: ProtocolNamespaceNavigation = {
  namespace: "dexscreener",
  advertised: true,
  groupId: "market-research",
  groupLabel: "Market Research",
  summary:
    "Vex's read-only market-research backbone and source of truth for DexScreener-indexed AMM "
    + "pairs, including robinhood, and DexScreener's own profile/promotion labels. Research flow: "
    + "discover → resolve the address with `token_find` → verify liquidity → quote on a venue. "
    + "It does not establish contract safety, token identity from a ticker, complete market "
    + "coverage, or an executable price.",
  whenToUse:
    "Route exactly: token address + chain -> `tokenPairs`; name/symbol -> `search`, select the exact chain + contract address, then `tokenPairs`; pool address + chain -> `pairs`; multiple addresses on one chain -> `tokens`; narrative -> `trending`, then `meta`; promotion -> `boosts`/`ads`, then per-token `orders`. Profiles report metadata updates, not token creation; CTO is a provider label, not proof. Trending/meta are live undocumented feeds influenced by engagement and promotion, not organic or genuine rankings.",
  preferInstead:
    "Use a dedicated chain safety tool for contract risk. For execution, always request a fresh quote from `kyberswap`, `solana`, or the chosen venue; never treat a DexScreener price as executable.",
  exampleQueries: [
    'discover_tools(query="trending narratives", namespace="dexscreener")',
    'discover_tools(query="community takeover", namespace="dexscreener")',
    'discover_tools(query="pair liquidity research", namespace="dexscreener")',
  ],
  aliases: ["dex screener", "market research", "trending narratives", "cto"],
  discoveryHints: [
    "token search",
    "pair analytics",
    "trending narratives",
    "boosts",
    "community takeover",
    "order verification",
    "ads",
  ],
  facets: [
    {
      label: "Search and pair analytics",
      summary: "Resolve a name/symbol to an exact chain + address, inspect a known pool, list one token's pools, or batch known addresses.",
      toolPrefixes: ["dexscreener.search", "dexscreener.pairs", "dexscreener.tokens", "dexscreener.tokenPairs"],
      hints: ["token search", "pair analytics", "price research", "all pools", "liquidity"],
    },
    {
      label: "Trending narratives and profiles",
      summary: "Browse live undocumented engagement/promotion-influenced narratives and profile metadata updates. Use attention only for an explicit request for Vex's synthetic profile-plus-boost merge.",
      toolPrefixes: [
        "dexscreener.trending",
        "dexscreener.meta",
        "dexscreener.attention",
        "dexscreener.profiles",
        "dexscreener.profiles.recent",
        "dexscreener.boosts",
        "dexscreener.boosts.top",
      ],
      hints: ["trending narratives", "trending metas", "synthetic profile boost merge", "token profiles", "boosts", "top boosts"],
    },
    {
      label: "Community takeovers and promotion checks",
      summary: "Read DexScreener CTO labels and inspect boosts, ads, and per-token promotion orders without inferring safety or demand.",
      toolPrefixes: ["dexscreener.communityTakeovers", "dexscreener.orders", "dexscreener.ads"],
      hints: ["community takeover", "cto", "paid orders", "ads", "promotion"],
    },
  ],
};
