import type { ProtocolNamespaceNavigation } from "../types.js";

export const VIRTUALS_NAVIGATION: ProtocolNamespaceNavigation = {
  namespace: "virtuals",
  advertised: true,
  groupId: "market-research",
  groupLabel: "Market Research",
  summary:
    "Virtuals Protocol agent-token intelligence on the exactly four chains Virtuals indexes: Robinhood (4663), Base, Solana and Ethereum, plus BONDING-CURVE TRADING on Base and Robinhood. It is the only place that answers UNDERGRAD-versus-graduated status, market cap denominated in VIRTUAL, the graduation feed and the anti-sniper buy-tax window - the one fact that decides whether buying right now costs almost everything.",
  whenToUse:
    "Use when the user names an agent token, asks what just graduated, or asks what is launching on Virtuals: screen agents on one chain, read one agent in full, watch the graduation feed, or browse the genesis calendar. It also QUOTES and EXECUTES a bonding-curve buy or sell for an agent that has not graduated. Always read the anti-sniper window before buying.",
  preferInstead:
    "Use `dexscreener` for general multi-chain pair/liquidity research. A GRADUATED agent has left its curve, so trade it with `SwapQuote`/`SwapExecute` (or `solana.*` on Solana); the curve tools here refuse it by name and say which AMM tool to use. Solana and Ethereum agents are read-only here - their curves are not BondingV5.",
  declaration: {
    identity: "Virtuals is intelligence for Virtuals agents and agent tokens across the chains indexed by the provider, and the bonding-curve trading venue for the agents that have not graduated on Base and Robinhood.",
    read: "Read one agent's bonding-curve trade tape and build a price chart from its pool's ohlcv candles, screen virtuals agents and agent tokens, inspect robinhood agent tokens or one agent in depth, read market cap, holder count and concentration, check the anti-sniper buy-tax window and exact venue, follow recent virtuals graduations or what just graduated, and browse the fresh graduations feed, genesis calendar, launch schedule, and genesis sales.",
    quote: "Price a bonding-curve buy or sell of an agent token that has not graduated, on Base or Robinhood: the output, the taxes, the anti-sniper window and the floor the contract will enforce. Research alone still establishes no executable price.",
    act: "Execute a bonding-curve buy or sell against a quote already taken, spending real funds under approval. Acquiring a GRADUATED agent token is still a separate swap task on the venue identified by the research result.",
    whenItApplies: "Use it when the user names an agent token, asks what just graduated, wants robinhood agent tokens, or asks what is launching through Virtuals.",
    characteristicAndLimits: "Bonding-curve pre-graduation can be illiquid and may never reach a locked liquidity pool. Verification is anti-impersonation, not a quality or safety signal. Rankings have no stated freshness guarantee, and no launch, cost, quota, or rate-limit action is exposed. A curve PURCHASE is exposed, but only for an agent that has not graduated, and only on Base and Robinhood.",
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
      "trade tape",
      "price chart",
      "ohlcv candles",
    ],
    facets: [
      "Agent-token screening and detail",
      "Graduations and launch calendar",
      "Trade tape and price history",
      "Creator fees on an agent",
      "Bonding-curve trading (buy/sell)",
    ],
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
    {
      label: "Trade tape and price history",
      summary: "Read one agent's bonding-curve trade tape and its pool's OHLCV candles, per chain and lifecycle stage.",
      toolPrefixes: ["virtuals.trades", "virtuals.candles"],
      hints: ["trade tape", "recent trades", "price chart", "candles", "ohlcv", "price history"],
    },
    {
      label: "Creator fees on an agent",
      summary:
        "Read what an agent's creator has earned from its bonding-curve trading tax at one pinned block: "
        + "collected, already swapped and paid out, and still pending, plus the split between the protocol "
        + "treasury, any partner and the creator. Collection is not Vex's to perform - the swap path is gated "
        + "on a role the creator wallet does not hold - so the claim answers unsupported with that measurement.",
      toolPrefixes: ["virtuals.creator_fees"],
      hints: [
        "virtuals creator fees",
        "how much have my agent fees earned",
        "agent tax accrued",
        "claim my virtuals creator fees",
        "creator fee split",
      ],
    },
    {
      label: "Bonding-curve trading (buy/sell)",
      summary:
        "Trade a Virtuals agent token that is still on its BondingV5 curve, on Base or Robinhood: price "
        + "it, then trade it against that price with the anti-sniper tax bound the caller accepted. An "
        + "agent that already graduated is refused by name, with the venue to use instead.",
      toolPrefixes: ["virtuals.trade.quote", "virtuals.trade.execute"],
      hints: [
        "buy this virtuals agent token",
        "sell agent tokens back to the curve",
        "quote a virtuals bonding curve trade",
        "ape into this virtuals launch",
        "anti-sniper tax before buying",
      ],
    },
  ],
};
