import type { ProtocolNamespaceNavigation } from "../types.js";

export const TRENCH_NAVIGATION: ProtocolNamespaceNavigation = {
    namespace: "trench",
    advertised: true,
    groupId: "evm-trading",
    groupLabel: "EVM Trading",
    summary:
      "Trade, research, and launch Trench Express bonding-curve tokens on Robinhood Chain (4663): buy a token with ETH or sell it back for ETH against the curve (quote first, then execute), browse bonding-curve and graduated tokens, search by name or symbol, read a token's recent trade tape, dry-run a launch to preview the predicted address, creation fee, and gas cost — or launch a real token (user-filled form, or direct execution under mission autonomy) and review your own past launches. A graduated token has left the bonding curve for a WETH-paired DEX pool on Robinhood Chain — its poolId and pool currencies are surfaced on the row. ETH curve only — no token/VEX pair exists on-chain today.",
    whenToUse:
      "Use to trade, vet, or launch Trench Express launchpad tokens: quote and then buy or sell a bonding-curve token, list what just launched or graduated, search for a named token, inspect its trade tape, preview what launching a new token would cost, or actually launch one and review your past launches. Trades and launches spend real ETH and are approval- or autonomy-gated; a launch requires an image the user pre-staged in the app.",
    preferInstead:
      "Use `kyberswap` to trade tokens that already trade in a standard AMM pool, and `dexscreener` for broader pair research. A graduated Trench token trades in a WETH-paired DEX pool on Robinhood Chain; where that pool is indexed, research it with `dexscreener`. `virtuals` is a different launchpad (VIRTUAL-paired agent tokens) — Trench tokens never appear there.",
    exampleQueries: [
      'discover_tools(query="buy a trench bonding curve token with ETH", namespace="trench")',
      'discover_tools(query="new token launches on trench", namespace="trench")',
      'discover_tools(query="preview a token launch cost", namespace="trench")',
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
