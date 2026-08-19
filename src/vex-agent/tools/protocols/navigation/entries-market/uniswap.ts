import type { ProtocolNamespaceNavigation } from "../types.js";

export const UNISWAP_NAVIGATION: ProtocolNamespaceNavigation = {
  // Agent Scan plan v3 §11.2 (FIX3-W7, Codex final-review round 2 finding 2
  // / C30): Uniswap is the HIDDEN fallback pair, session-reveal-gated. It
  // must not be statically advertised anywhere — `advertised: false` here
  // is the single source of truth that removes it from
  // `PROTOCOL_ADVERTISED_NAMESPACE_ALLOWLIST` (catalog.ts derives that list
  // FROM this flag), `buildDiscoverNamespaceDescription()`'s static schema
  // text, `discoverProtocolCapabilities`'s candidate filter (so it never
  // surfaces via discover_tools even for a revealed session — the sanctioned
  // path there is the `swap_quote_uniswap`/`swap_execute_uniswap` internal
  // aliases, not generic discovery), and the built `# Available Protocol
  // Namespaces` prompt section. `executeProtocolTool`'s OWN reveal gate
  // (`REVEAL_GATED_UNISWAP_TOOL_IDS` + `isUniswapPairRevealed`, in
  // `runtime.ts`) is independent of this flag and still allows a revealed
  // session's alias-routed execute_tool dispatch through.
  namespace: "uniswap",
  advertised: false,
  groupId: "evm-trading",
  groupLabel: "EVM Trading",
  summary: "Keyless on-chain Uniswap V2/V3 swaps (best route). An all-EVM fallback for KyberSwap, including on Robinhood Chain (4663) — where $VEX and Virtuals agent tokens trade against VIRTUAL.",
  whenToUse:
    "Use as a fallback on any EVM chain when KyberSwap is unavailable or lacks a route, including Robinhood Chain (quote/execute against VIRTUAL/ETH). Pass token contract ADDRESSES (no symbol search).",
  preferInstead:
    "Prefer `kyberswap` on the chains it supports (aggregated pricing + token safety flags), incl. Robinhood Chain; use `uniswap` when Kyber lacks the chain/route.",
  exampleQueries: [
    'discover_tools(query="swap on robinhood", namespace="uniswap")',
    'discover_tools(query="uniswap quote", namespace="uniswap")',
    'discover_tools(query="buy vex with virtual", namespace="uniswap")',
  ],
  aliases: ["uniswap", "robinhood swap", "v2 v3 swap", "uniswap fallback"],
  discoveryHints: ["swap on robinhood", "uniswap quote", "buy on robinhood", "sell on robinhood", "virtual to vex"],
  facets: [
    {
      label: "Swaps",
      summary: "Quote or execute best-route V2/V3 swaps after resolving token addresses.",
      toolPrefixes: ["uniswap.swap"],
      hints: ["swap quote", "sell token", "buy token", "robinhood swap", "best route v2 v3"],
    },
  ],
};
