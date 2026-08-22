import type { ProtocolNamespaceNavigation } from "../types.js";

export const SOLANA_NAVIGATION: ProtocolNamespaceNavigation = {
  namespace: "solana",
  advertised: true,
  groupId: "solana",
  groupLabel: "Solana",
  summary:
    "Jupiter's whole Solana surface: token identity and prices, swaps routed by Jupiter, Earn lending and collateralized Borrow, and Jupiter prediction markets. It is both the FRESHEST token feed Vex has - a recent-mints read measured rows 10 to 175 seconds old, each with its own createdAt - and the only namespace that can execute on Solana.",
  whenToUse:
    "Use when the chain is Solana: resolve a mint, price a token, find freshly launched or trending tokens, quote and then execute a swap, read or move an Earn or Borrow position, or browse and trade prediction markets.",
  preferInstead:
    "Use `khalani` to bridge onto or off Solana, and `kyberswap` for EVM execution.",
  exampleQueries: [
    'ToolSearch(query="solana token search", namespace="solana")',
    'ToolSearch(query="swap on solana", namespace="solana")',
    'ToolSearch(query="solana prediction markets", namespace="solana")',
  ],
  aliases: ["jupiter", "solana swap", "solana lending", "solana prediction"],
  discoveryHints: ["token mint search", "fresh solana launches", "new solana tokens", "solana swap", "jupiter price", "lend rates", "prediction market"],
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
