import type { ProtocolNamespaceNavigation } from "../types.js";

export const UNISWAP_NAVIGATION: ProtocolNamespaceNavigation = {
  // Owner decision D4 (`tool-surface-spec/owner-decisions.md`), superseding the
  // Agent Scan plan v3 §11.2 hidden-pair design: the Uniswap venue tools LOSE
  // their reveal gating and become always-visible alternatives alongside the
  // KyberSwap router. `advertised: true` is the single source of truth that
  // admits the namespace to `PROTOCOL_ADVERTISED_NAMESPACE_ALLOWLIST`
  // (catalog.ts derives that list FROM this flag),
  // `buildDiscoverNamespaceDescription()`'s static schema text,
  // `discoverProtocolCapabilities`'s candidate filter, and the built
  // `# Available Protocol Namespaces` prompt section - so these tools now
  // discover normally instead of only through the internal aliases.
  //
  // Available is not preferred: `preferInstead` below, and the Tool Map
  // doctrine in the system prompt, both state that KyberSwap is the primary
  // swap route and this is the alternative.
  namespace: "uniswap",
  advertised: true,
  groupId: "evm-trading",
  groupLabel: "EVM Trading",
  summary: "Uniswap is on-chain spot swapping straight against V2 and V3 pools, routed for the best of the two and quoted before it is executed. It is Vex's all-EVM alternative to the KyberSwap aggregator, and the venue that covers Robinhood Chain (4663), where $VEX and Virtuals agent tokens trade against VIRTUAL. It takes token contract ADDRESSES; there is no symbol search.",
  whenToUse:
    "Use as a fallback on any EVM chain when KyberSwap is unavailable or lacks a route, including Robinhood Chain (quote/execute against VIRTUAL/ETH). Pass token contract ADDRESSES (no symbol search).",
  preferInstead:
    "Prefer `kyberswap` on the chains it supports (aggregated pricing + token safety flags), incl. Robinhood Chain; use `uniswap` when Kyber lacks the chain/route.",
  declaration: {
    identity: "Uniswap is an on-chain spot-swap venue that compares V2 and V3 pools for an exact-input trade.",
    read: "Read a route preview's pool path, expected output, price impact, gas estimate, and token-safety signals. Token identity must already be resolved because this venue has no symbol search.",
    quote: "Create a read-only route preview with the best route before funds move.",
    act: "Execute a buy, sell, or swap after a fresh matching quote. A token approval may be required before the wallet signs and broadcasts the trade.",
    whenItApplies: "Use Uniswap for a V2 and V3 pools swap on a verified deployment, including a Robinhood Chain trade against VIRTUAL, after resolving exact token addresses.",
    characteristicAndLimits: "Availability is limited to verified deployments. Quotes are point-in-time and execution is exact-input, so re-quote when conditions change. It cannot search by ticker, guarantee output, or prove token safety from a route alone.",
    retrievalTerms: [
      "Uniswap",
      "V2 and V3 pools",
      "best route",
      "expected output",
      "price impact",
      "token-safety signals",
      "Robinhood Chain",
      "VIRTUAL",
      "route preview",
      "Read-only",
      "exact-input",
      "token approval",
    ],
    facets: ["Swaps"],
  },
  exampleQueries: [
    'ToolSearch(query="swap on robinhood", namespace="uniswap")',
    'ToolSearch(query="uniswap quote", namespace="uniswap")',
    'ToolSearch(query="buy vex with virtual", namespace="uniswap")',
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
