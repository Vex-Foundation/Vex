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
