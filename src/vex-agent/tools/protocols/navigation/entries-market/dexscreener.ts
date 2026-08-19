import type { ProtocolNamespaceNavigation } from "../types.js";

export const DEXSCREENER_NAVIGATION: ProtocolNamespaceNavigation = {
    namespace: "dexscreener",
    advertised: true,
    groupId: "market-research",
    groupLabel: "Market Research",
    summary: "The market-research backbone: read-only, multi-chain DEX intelligence — search any token on any chain (chainId filter, including robinhood), resolve token addresses, verify pair liquidity/momentum, and read trending narratives, attention/boost signals, CTO signals, ads, and paid-order verification.",
    whenToUse:
      "Reach for it FIRST on any RESEARCH step (it never executes): search a token on any chain, verify the pair's liquidity and momentum, and separate genuine narratives (trending/meta) from paid attention (boost/attention signals). Research flow: discover → resolve the address with `token_find` → verify liquidity → quote on a venue.",
    preferInstead:
      "Use `kyberswap`, `solana`, or `khalani` for execution after the discovery step — DexScreener never executes.",
    exampleQueries: [
      'discover_tools(query="trending narratives", namespace="dexscreener")',
      'discover_tools(query="community takeover", namespace="dexscreener")',
      'discover_tools(query="pair liquidity research", namespace="dexscreener")',
    ],
    aliases: ["dex screener", "market research", "trending narratives", "attention signal", "cto"],
    discoveryHints: [
      "token search",
      "pair analytics",
      "trending narratives",
      "attention signal",
      "boosts",
      "community takeover",
      "order verification",
      "ads",
    ],
    facets: [
      {
        label: "Search and pair analytics",
        summary: "Search tokens/pairs (by chain/liquidity) and inspect pair detail or all pools for a token.",
        toolPrefixes: ["dexscreener.search", "dexscreener.pairs", "dexscreener.tokens", "dexscreener.tokenPairs"],
        hints: ["token search", "pair analytics", "price research", "all pools", "liquidity"],
      },
      {
        label: "Trending narratives, attention, and profiles",
        summary: "Browse official trending narratives/themes and their tokens, synthetic attention/boost signals, and token profiles.",
        toolPrefixes: [
          "dexscreener.trending",
          "dexscreener.meta",
          "dexscreener.attention",
          "dexscreener.profiles",
          "dexscreener.profiles.recent",
          "dexscreener.boosts",
          "dexscreener.boosts.top",
        ],
        hints: ["trending narratives", "trending metas", "attention signal", "token profiles", "boosts", "top boosts"],
      },
      {
        label: "Community takeovers and promotion checks",
        summary: "Track CTO signals plus ads and paid-order verification.",
        toolPrefixes: ["dexscreener.communityTakeovers", "dexscreener.orders", "dexscreener.ads"],
        hints: ["community takeover", "cto", "paid orders", "ads", "promotion"],
      },
    ],
  };
