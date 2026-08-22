import type { ProtocolNamespaceNavigation } from "../types.js";

export const DEXSCREENER_NAVIGATION: ProtocolNamespaceNavigation = {
  namespace: "dexscreener",
  advertised: true,
  groupId: "market-research",
  groupLabel: "Market Research",
  summary:
    "Vex's read-only market-research backbone and source of truth for DexScreener-indexed AMM "
    + "pairs, including robinhood, and DexScreener's own profile/promotion labels. Research flow: "
    + "discover → resolve the address with `TokenFind` → verify liquidity → quote on a venue. "
    + "Characteristic: its pool depth, liquidity and volume observations are real, but indexing "
    + "LAGS - on some chains a new pair takes hours to appear - so it answers how deep and how "
    + "real a market is, not what launched in the last hour, and it is not a token-creation or "
    + "newly-listed-pair feed. "
    + "It does not establish contract safety, token identity from a ticker, complete market "
    + "coverage, or an executable price.",
  whenToUse:
    "Route exactly: token address + chain -> `tokenPairs`; name/symbol -> `search`, select the exact chain + contract address, then `tokenPairs`; pool address + chain -> `pairs`; multiple addresses on one chain -> `tokens`; narrative -> `trending`, then `meta`; promotion -> `boosts`/`ads`, then per-token `orders`. Profiles report metadata updates, not token creation; CTO is a provider label, not proof. Trending/meta are live undocumented feeds influenced by engagement and promotion, not organic or genuine rankings.",
  preferInstead:
    "Use a dedicated chain safety tool for contract risk. For execution, always request a fresh quote from `kyberswap`, `solana`, or the chosen venue; never treat a DexScreener price as executable.",
  declaration: {
    identity: "DexScreener is read-only market research for indexed automated-market-maker pairs and the provider's own profile, narrative, and promotion labels.",
    read: "Resolve a name or symbol to an exact chain and contract address, inspect a pool address, compare pools for one token, or batch multiple exact token addresses. Read liquidity, volume, price, transactions, age, token profile metadata, trending narratives, community-takeover labels, paid boosts, ad placements, paid promotional orders, and the synthetic profile plus boost merge.",
    quote: "No quote capability is available. Market observations are display data, not a fresh executable quote.",
    act: "No action capability is available. This namespace never signs, broadcasts, buys, sells, or changes provider data.",
    whenItApplies: "Use it for pair liquidity research, cross-pool price sanity, a known pool, exact-address analytics, trending narratives, profile metadata, community takeover checks, or paid promotion inspection.",
    characteristicAndLimits: "Indexing lags and a missing row does not prove that no market exists. Provider rankings can be influenced by engagement and promotion. The data does not establish contract safety, canonical identity from a ticker, complete market coverage, organic demand, or an executable price.",
    retrievalTerms: [
      "name or symbol",
      "exact chain and contract address",
      "pool address",
      "multiple exact token addresses",
      "fresh executable quote",
      "token profile metadata",
      "paid boosts",
      "community-takeover",
      "synthetic profile plus boost merge",
      "trending narratives",
      "paid promotional orders",
      "ad placements",
    ],
    facets: [
      "Search and pair analytics",
      "Trending narratives and profiles",
      "Community takeovers and promotion checks",
    ],
    coverageNote: "Coverage follows the provider's index; name the chain in the request.",
  },
  exampleQueries: [
    'ToolSearch(query="trending narratives", namespace="dexscreener")',
    'ToolSearch(query="community takeover", namespace="dexscreener")',
    'ToolSearch(query="pair liquidity research", namespace="dexscreener")',
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
        "dexscreener.boosts",
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
