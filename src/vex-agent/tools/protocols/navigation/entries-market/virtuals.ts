import type { ProtocolNamespaceNavigation } from "../types.js";

export const VIRTUALS_NAVIGATION: ProtocolNamespaceNavigation = {
  namespace: "virtuals",
  advertised: true,
  groupId: "market-research",
  groupLabel: "Market Research",
  summary:
    "Virtuals Protocol agent-token intelligence, READ-ONLY, on the exactly four chains Virtuals indexes: Robinhood (4663), Base, Solana and Ethereum. It is the only place that answers UNDERGRAD-versus-graduated status, market cap denominated in VIRTUAL, the graduation feed and the anti-sniper buy-tax window - the one fact that decides whether buying right now costs almost everything.",
  whenToUse:
    "Use when the user names an agent token, asks what just graduated, or asks what is launching on Virtuals: screen agents on one chain, read one agent in full, watch the graduation feed, or browse the genesis calendar. Always read the anti-sniper window before buying.",
  preferInstead:
    "Use `dexscreener` for general multi-chain pair/liquidity research, and `SwapQuote`/`SwapExecute` (or `solana.*` on Solana) to execute the trade — Virtuals never executes.",
  declaration: {
    identity: "Virtuals is read-only intelligence for Virtuals agents and agent tokens across the chains indexed by the provider.",
    read: "Screen virtuals agents and agent tokens, inspect robinhood agent tokens or one agent in depth, read market cap, holder count and concentration, check the anti-sniper buy-tax window and exact venue, follow recent virtuals graduations or what just graduated, and browse the fresh graduations feed, genesis calendar, launch schedule, and genesis sales.",
    quote: "No quote capability is available. Research does not establish an executable price, route, or minimum received amount.",
    act: "No action capability is available. Acquiring an agent token is a separate swap task on the venue identified by the research result.",
    whenItApplies: "Use it when the user names an agent token, asks what just graduated, wants robinhood agent tokens, or asks what is launching through Virtuals.",
    characteristicAndLimits: "Bonding-curve pre-graduation can be illiquid and may never reach a locked liquidity pool. Verification is anti-impersonation, not a quality or safety signal. Rankings have no stated freshness guarantee, and no purchase, launch, cost, quota, or rate-limit action is exposed.",
    retrievalTerms: [
      "virtuals agents",
      "agent tokens",
      "robinhood agent tokens",
      "anti-sniper buy-tax window",
      "recent virtuals graduations",
      "just graduated",
      "fresh graduations feed",
      "genesis calendar",
      "launch schedule",
      "genesis sales",
      "market cap",
      "holder count",
      "concentration",
      "bonding-curve pre-graduation",
      "locked liquidity pool",
      "exact venue",
    ],
    facets: ["Agent-token screening and detail", "Graduations and launch calendar"],
  },
  exampleQueries: [
    'ToolSearch(query="list agent tokens on robinhood", namespace="virtuals")',
    'ToolSearch(query="virtuals agent detail anti-sniper", namespace="virtuals")',
    'ToolSearch(query="what just graduated", namespace="virtuals")',
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
