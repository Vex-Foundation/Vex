import type { ProtocolNamespaceNavigation } from "../types.js";

export const KHALANI_NAVIGATION: ProtocolNamespaceNavigation = {
  namespace: "khalani",
  advertised: true,
  groupId: "cross-chain",
  groupLabel: "Cross-chain",
  summary: "The bridge Vex moves tokens between blockchains with, across the EVM and Solana chains its own live registry returns, and the canonical cross-chain token resolver behind it: resolve a ticker or address to the exact contract on a chain, read balances across chains, quote a transfer, execute it, and track the order to delivery.",
  whenToUse:
    "Use when the task crosses chains: bridge funds from one network to another, get assets onto the chain a trade needs, check what a transfer would deliver and how long it takes, or look up an in-flight or past bridge. Also use it to resolve a token symbol or address before ANY EVM swap or bridge, through the `TokenFind` shortcut. Bridges quote first and then execute, and a real execution reports delivery still in progress rather than a completed transfer.",
  preferInstead:
    "Khalani is the PRIMARY bridge: use `relay` when Khalani has no route, and always when either side is Robinhood Chain (4663), which Khalani's registry does not carry. Use `kyberswap` for EVM-only swaps and `solana` for Solana-only swaps.",
  exampleQueries: [
    'ToolSearch(query="token search", namespace="khalani")',
    'ToolSearch(query="bridge quote", namespace="khalani")',
    'ToolSearch(query="cross-chain order status", namespace="khalani")',
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
