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
  declaration: {
    identity: "Jupiter provides Vex's Solana token research, swaps, lending, collateralized borrowing, and prediction markets.",
    read: "Read real-time USD prices, resolve a Solana SPL token, screen new Solana launches, inspect liquidity and safety signals, compare Jupiter Lend Earn markets, read borrowing liquidity and liquidation threshold, and inspect prediction positions, a leaderboard, or protocol vault balance.",
    quote: "Preview a swap on Solana with the best route on Solana, expected and minimum output, price impact, slippage, fees, tip, and account-rent disclosure. Lending and prediction actions have no separate generic quote surface, so read their market and position state before acting.",
    act: "Execute a matched Solana swap, deposit or withdraw from Earn, operate a collateralized borrowing position, and buy or sell a YES/NO prediction market outcome. After resolution, claim payout for a winning market.",
    whenItApplies: "Use it for Solana token identity, fresh-token discovery, a swap on Solana, to earn yield on Solana through Jupiter Lend Earn, collateralized borrowing, or a prediction market with an order book or market depth.",
    characteristicAndLimits: "Fresh discovery is measured but a missing creation time means unknown age. Missing borrowing risk data means unknown, never healthy. Prediction sells and claims settle later, bulk closes are independent actions, and some provider analytics are unavailable or unverified. Every capability requires its configured API credential.",
    retrievalTerms: [
      "real-time USD prices",
      "Solana SPL token",
      "new Solana launches",
      "swap on Solana",
      "best route on Solana",
      "Jupiter Lend Earn",
      "earn yield",
      "collateralized borrowing",
      "liquidation threshold",
      "prediction market",
      "YES/NO",
      "market depth",
      "order book",
      "prediction positions",
      "claim payout",
      "leaderboard",
      "vault balance",
    ],
    facets: ["Core token and price lookup", "Swaps and lending", "Prediction markets"],
  },
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
