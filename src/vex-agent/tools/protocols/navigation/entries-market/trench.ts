import type { ProtocolNamespaceNavigation } from "../types.js";

export const TRENCH_NAVIGATION: ProtocolNamespaceNavigation = {
  namespace: "trench",
  advertised: true,
  groupId: "evm-trading",
  groupLabel: "EVM Trading",
  summary:
    "Trench Express, the BONDING-CURVE launchpad on Robinhood Chain (4663): its own registry of curve and graduated tokens, the ETH-curve trade path that is the ONLY way to trade a token still on its curve, and the launch path itself. Because it is the launchpad's own registry with an about 2-second cache, it sees a token from its FIRST BLOCK - which is exactly why it is reached for ahead of an indexer, and why a token missing from `dexscreener` is still here.",
  whenToUse:
    "Use when the user names Trench, asks what just launched on Robinhood Chain, or wants to buy, sell or launch a curve token: quote then trade against the curve, screen or search the registry, read a token's trade tape, price a launch, launch one, or review their own launches. Trades and launches spend real ETH, are approval-gated, and a launch requires an image the user pre-staged in the app.",
  preferInstead:
    "Use `kyberswap` to trade tokens that already trade in a standard AMM pool, and `dexscreener` for broader pair research. A graduated Trench token trades in a WETH-paired DEX pool on Robinhood Chain; where that pool is indexed, research it with `dexscreener`. `virtuals` is a different launchpad (VIRTUAL-paired agent tokens) — Trench tokens never appear there.",
  declaration: {
    identity: "Trench Express is a bonding-curve launchpad whose registry, curve trading, and launch lifecycle are native to the product.",
    read: "Browse the Trench Express launchpad, screen new launches on Trench, resolve a named token by address, inspect curve state, read a trade tape, list staged images in the Trench image locker, and review my Trench launches.",
    quote: "Preview a bonding curve buy or sell with output, price impact, and curve progress. Preview a launch with its estimated total cost, gas, predicted address, and balance checks before committing.",
    act: "Buy this Trench token with the curve's native asset, sell my Trench launchpad tokens back to the curve, open the launch form for a human decision, or deploy the token from a staged image under the applicable authority.",
    whenItApplies: "Use it for Robinhood Chain launchpad discovery, a token still on its bonding curve, a requested curve trade, the Trench Photos workflow, or a request to launch a token for me.",
    characteristicAndLimits: "The launchpad registry is faster than a general indexer but covers only Trench tokens. A graduated token leaves the curve for a standard pool. Symbols are not identity, curve prices are not USD prices, staged images cannot be created by the agent, and a pending or identity-unproven broadcast must not be retried.",
    retrievalTerms: [
      "Trench Express launchpad",
      "Robinhood Chain",
      "bonding curve",
      "new launches on trench",
      "trade tape",
      "price impact",
      "Trench image locker",
      "Trench Photos",
      "estimated total cost",
      "launch a token for me",
      "open the launch form",
      "deploy the token",
      "my trench launches",
      "buy this trench token",
      "sell my trench launchpad tokens",
    ],
    facets: [
      "Trench curve trading (buy/sell)",
      "Trench launchpad token browsing and search",
      "Trench trade tape and launch preview",
      "Launching a token on Trench",
    ],
  },
  exampleQueries: [
    'ToolSearch(query="buy a trench bonding curve token with ETH", namespace="trench")',
    'ToolSearch(query="new token launches on trench", namespace="trench")',
    'ToolSearch(query="preview a token launch cost", namespace="trench")',
  ],
  aliases: ["trench", "trench express", "trench launchpad", "trench token launches", "trench curve trading", "buy trench token"],
  discoveryHints: [
    "buy a trench bonding curve token",
    "sell a trench launchpad token for eth",
    "new token launches on trench",
    "trench bonding curve tokens",
    "trench launchpad trade tape",
    "robinhood launchpad tokens",
  ],
  facets: [
    {
      label: "Trench curve trading (buy/sell)",
      summary: "Quote then buy a Trench bonding-curve token with ETH, or sell it back for ETH, with a Vex-derived minimum-output floor.",
      toolPrefixes: ["trench.trade_quote", "trench.trade_execute"],
      hints: ["buy trench token with eth", "sell trench token for eth", "quote a trench curve trade", "trench bonding curve buy", "trench bonding curve sell"],
    },
    {
      label: "Trench launchpad token browsing and search",
      summary: "List and screen Trench Express bonding-curve and graduated tokens, or look one up by name or symbol.",
      toolPrefixes: ["trench.tokens", "trench.search"],
      hints: ["trench launchpad tokens", "new trench launches", "trench bonding curve", "trench token lookup", "trench token by symbol"],
    },
    {
      label: "Trench trade tape and launch preview",
      summary: "Read a Trench token's recent trade tape and dry-run a Trench token launch to preview address, fee, and gas cost.",
      toolPrefixes: ["trench.trades", "trench.launch_preview"],
      hints: ["trench trade tape", "recent trench trades", "trench launch preview", "create trench token cost", "dry run trench launch"],
    },
    {
      label: "Launching a token on Trench",
      summary:
        "Create a token on the Trench bonding curve, and review the ones already launched. A launch REQUIRES an image the user pre-staged in the app; the agent cannot supply one.",
      toolPrefixes: ["trench.launch_request_form", "trench.launch_execute", "trench.my_launches", "trench.images"],
      hints: [
        "launch a token on trench",
        "create a memecoin",
        "deploy a token",
        "my launched tokens",
        "trench launch images",
        "pick a launch image",
      ],
    },
  ],
};
