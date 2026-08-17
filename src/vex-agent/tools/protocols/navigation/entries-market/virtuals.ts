import type { ProtocolNamespaceNavigation } from "../types.js";

export const VIRTUALS_NAVIGATION: ProtocolNamespaceNavigation = {
  namespace: "virtuals",
  advertised: true,
  groupId: "market-research",
  groupLabel: "Market Research",
  summary:
    "Read-only Virtuals Protocol agent-token intelligence — screen, inspect, and track agent tokens on Robinhood (chain 4663), Base, Solana, and Ethereum: status (bonding-curve UNDERGRAD vs graduated), holders, market cap in VIRTUAL, the anti-sniper buy-tax window, recent graduations, and the genesis launch calendar.",
  whenToUse:
    "Use to discover or vet a Virtuals agent token before trading it: list/screen agents on a chain, get one agent's full detail, watch the 'what just graduated' feed, or browse the genesis launch calendar. The trading rules live in the Virtuals Agent Tokens doctrine below.",
  preferInstead:
    "Use `dexscreener` for general multi-chain pair/liquidity research, and `swap_quote`/`swap_execute` (or `solana.*` on Solana) to execute the trade — Virtuals never executes.",
  exampleQueries: [
    'discover_tools(query="list agent tokens on robinhood", namespace="virtuals")',
    'discover_tools(query="virtuals agent detail anti-sniper", namespace="virtuals")',
    'discover_tools(query="what just graduated", namespace="virtuals")',
  ],
  aliases: ["virtuals", "agent tokens", "virtuals protocol", "anti-sniper window", "agent token graduations"],
  discoveryHints: [
    "agent tokens on robinhood",
    "virtuals agent detail",
    "anti-sniper buy tax window",
    "recent graduations",
    "genesis launch calendar",
  ],
  facets: [
    {
      label: "Agent-token screening and detail",
      summary: "List/screen agent tokens on a chain and pull one agent's full detail, anti-sniper window, and trading route.",
      toolPrefixes: ["virtuals.list", "virtuals.get"],
      hints: ["agent tokens", "virtuals list", "agent detail", "anti-sniper window", "trading route"],
    },
    {
      label: "Graduations and launch calendar",
      summary: "Watch recently graduated agent tokens and browse the genesis launch calendar.",
      toolPrefixes: ["virtuals.graduations", "virtuals.geneses"],
      hints: ["recent graduations", "just graduated", "genesis calendar", "upcoming launches"],
    },
  ],
};
