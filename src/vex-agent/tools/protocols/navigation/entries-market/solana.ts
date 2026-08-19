import type { ProtocolNamespaceNavigation } from "../types.js";

export const SOLANA_NAVIGATION: ProtocolNamespaceNavigation = {
    namespace: "solana",
    advertised: true,
    groupId: "solana",
    groupLabel: "Solana",
    summary: "Jupiter-backed Solana surface for token search, prices, swaps, lending, and prediction markets.",
    whenToUse:
      "Use when the task is Solana-only: resolve mints, fetch Jupiter prices, swap on Solana, inspect lend positions, or trade Jupiter prediction markets.",
    preferInstead:
      "Use `khalani` for cross-chain bridging and `kyberswap` for EVM-only execution.",
    exampleQueries: [
      'discover_tools(query="solana token search", namespace="solana")',
      'discover_tools(query="swap on solana", namespace="solana")',
      'discover_tools(query="solana prediction markets", namespace="solana")',
    ],
    aliases: ["jupiter", "solana swap", "solana lending", "solana prediction"],
    discoveryHints: ["token mint search", "solana swap", "jupiter price", "lend rates", "prediction market"],
    facets: [
      {
        label: "Core token and price lookup",
        summary: "Search Solana mints and fetch prices/trending token metadata.",
        toolPrefixes: ["solana.prices", "solana.tokens"],
        hints: ["token search", "token mint", "trending tokens", "price lookup"],
      },
      {
        label: "Swaps and lending",
        summary: "Quote/execute swaps and inspect deposit/withdraw lend positions.",
        toolPrefixes: ["solana.swap", "solana.lend"],
        hints: ["swap quote", "swap execute", "lend rates", "lend positions"],
      },
      {
        label: "Prediction markets",
        summary: "Browse, analyze, and trade Jupiter prediction markets on Solana.",
        toolPrefixes: ["solana.predict"],
        hints: ["prediction market", "buy yes", "sell shares", "market history"],
      },
    ],
  };
