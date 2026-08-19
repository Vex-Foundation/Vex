import type { ProtocolNamespaceNavigation } from "../types.js";

/**
 * pools.fun - the no-curve launchpad on Robinhood Chain (4663).
 *
 * The cross-links matter more here than on most namespaces, because the
 * namespace deliberately has NO trading tool: pools.fun tokens live in ordinary
 * SushiSwap V3 pools from their first block, which the existing `kyberswap`
 * venue already routes (13 of 13 sampled tokens, including ones minutes old).
 * `preferInstead` is where the agent is told that, so it does not go looking for
 * a swap tool that will never exist in this namespace.
 */
export const POOLS_NAVIGATION: ProtocolNamespaceNavigation = {
  namespace: "pools",
  advertised: true,
  groupId: "evm-trading",
  groupLabel: "EVM Trading",
  summary:
    "Research and screen pools.fun launchpad tokens on Robinhood Chain (4663): browse and filter launches by age, volume, trade count, market cap, deployer or fee recipient, look one up by name, read its price history as candles, and deep-read a single token against the chain (canonical pool, creator, fee recipient, fee split, decimals). pools.fun has NO bonding curve and NO graduation - a token trades in a real SushiSwap V3 pool with a 1 percent fee from its first block, and total supply is always one billion. Two launchers share this chain (pools.fun and the older sushi launchpad); the browsing tools take a platform selector, while the single-token tools resolve whichever launcher a token belongs to.",
  whenToUse:
    "Use to find, screen, or vet a pools.fun token: what launched in the last few hours, what is trading heaviest, who deployed a token and who earns its fees, how it has traded, or what the user launched themselves. All of it is read-only; nothing in this namespace spends.",
  preferInstead:
    "Use `kyberswap` to QUOTE AND TRADE these tokens - they trade in ordinary SushiSwap V3 pools on Robinhood Chain that KyberSwap routes, so this namespace deliberately has no swap tool. Use `dexscreener` for pair-level liquidity research (these pools are indexed there as dexId sushiswap, label v3, chain robinhood). `trench` is a DIFFERENT launchpad on the same chain: it has a bonding curve and a graduation step, while pools.fun has neither, so their tokens never overlap.",
  exampleQueries: [
    'discover_tools(query="new pools fun launches", namespace="pools")',
    'discover_tools(query="pools fun token price history", namespace="pools")',
    'discover_tools(query="who earns fees on this pools fun token", namespace="pools")',
  ],
  aliases: ["pools", "pools.fun", "pools fun", "bankr", "robinhood launchpad", "sushi launchpad"],
  discoveryHints: [
    "new pools fun launches",
    "pools fun tokens",
    "fresh launches on robinhood",
    "pools fun price history",
    "who deployed this pools fun token",
    "my pools fun launches",
  ],
  facets: [
    {
      label: "pools.fun browsing and search",
      summary:
        "List and screen pools.fun launches with every server-side filter (age, volume window, trade count, market-cap band, deployer, fee recipient), or resolve one token by name or symbol.",
      toolPrefixes: ["pools.tokens", "pools.search"],
      hints: [
        "pools fun tokens",
        "new pools fun launches",
        "fresh robinhood launchpad tokens",
        "find a pools fun token by name",
        "pools fun token lookup",
      ],
    },
    {
      label: "pools.fun candles and token detail",
      summary:
        "Read one token's OHLCV price history at any candle span, or its full detail joined with the on-chain locker registration, fee split and decimals.",
      toolPrefixes: ["pools.candles", "pools.token"],
      hints: [
        "pools fun price history",
        "pools fun chart",
        "pools fun token detail",
        "pools fun fee split",
        "which pool does this token trade in",
      ],
    },
    {
      label: "Own pools.fun launches",
      summary:
        "Review the tokens the session's own wallet deployed on pools.fun, and claim the creator fees they have "
        + "earned. Every pool charges 1 percent per trade and the launcher's share accrues in the locker until "
        + "it is claimed; a claim pays the launched token and the paired asset together.",
      toolPrefixes: ["pools.my_launches", "pools.claim_fees"],
      hints: [
        "my pools fun launches",
        "tokens I launched on pools fun",
        "the coin I made on pools fun",
        "claim my creator fees",
        "how much has my coin earned",
      ],
    },
    {
      label: "Launching a token on pools.fun",
      summary:
        "Price a launch before committing to it, ask the user to confirm one in the app's form, or launch for "
        + "real. A pools.fun token opens directly into a real SushiSwap V3 pool against WETH or USDG, with no "
        + "bonding curve and no graduation step. The preview is advisory and the form's submission is what "
        + "authorizes a launch; only launch_execute signs, and it verifies the launchpad's own transaction "
        + "against the chain before it does.",
      toolPrefixes: ["pools.launch_preview", "pools.launch_request_form", "pools.launch_execute"],
      hints: [
        "launch a token on pools fun",
        "what would a pools fun launch cost",
        "create a coin on pools fun",
        "confirm a pools fun launch",
        "pools fun launch form",
        "launch my pools fun coin now",
      ],
    },
  ],
};
