import type { ProtocolNamespaceNavigation } from "../types.js";

export const KHALANI_NAVIGATION: ProtocolNamespaceNavigation = {
    namespace: "khalani",
    advertised: true,
    groupId: "cross-chain",
    groupLabel: "Cross-chain",
    summary: "Cross-chain bridge, token resolver, balances, quotes, and order tracking across EVM + Solana chains.",
    whenToUse:
      "Use when the task crosses chains or needs multi-chain token resolution, wallet balances, a bridge quote, or a bridge execution flow. Token resolution is exposed as the `token_find` shortcut — prefer it. The full khalani toolset is listable with discover_tools for this namespace.",
    preferInstead:
      "Use `kyberswap` for EVM-only swaps and `solana` for Solana-only swaps.",
    exampleQueries: [
      'discover_tools(query="token search", namespace="khalani")',
      'discover_tools(query="bridge quote", namespace="khalani")',
      'discover_tools(query="cross-chain order status", namespace="khalani")',
    ],
    aliases: ["bridge", "cross chain", "hyperstream", "multi chain token resolver"],
    discoveryHints: [
      "bridge quote",
      "cross-chain transfer",
      "token resolver",
      "balances across chains",
      "bridge order status",
    ],
    facets: [
      {
        label: "Chains and token resolution",
        summary: "List supported chains and resolve/search token metadata before any multi-chain or EVM mutation.",
        toolPrefixes: ["khalani.chains", "khalani.tokens"],
        hints: ["supported chains", "token search", "token autocomplete", "wallet balances"],
      },
      {
        label: "Bridge quotes and orders",
        summary: "Quote/execute cross-chain transfers and inspect bridge order lifecycle.",
        toolPrefixes: ["khalani.quote", "khalani.orders", "khalani.bridge"],
        hints: ["bridge quote", "bridge usdc", "order status", "cross-chain bridge"],
      },
    ],
  };
