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
    "pools.fun, the NO-CURVE launchpad on Robinhood Chain (4663): its own registry of launches, one-token deep reads against the chain, price candles, the creator-fee claim, and the launch path. A pools.fun token has no bonding curve and no graduation - it opens straight into a real SushiSwap V3 pool with a 1 percent fee, at a fixed one-billion supply - so this registry sees it from its FIRST BLOCK, which is why it is reached for ahead of an indexer.",
  whenToUse:
    "Use when the user names pools.fun, asks what just launched on Robinhood Chain, or wants to vet, launch, or collect fees on one: screen or search the launchpad, read one token against the chain, read its candles, review their own launches, claim the creator fees a launch earned, or launch a token. Only the claim and the launch spend; everything else is read-only.",
  preferInstead:
    "Use `kyberswap` to QUOTE AND TRADE these tokens - they trade in ordinary SushiSwap V3 pools on Robinhood Chain that KyberSwap routes, so this namespace deliberately has no swap tool. Use `dexscreener` for pair-level liquidity research (these pools are indexed there as dexId sushiswap, label v3, chain robinhood). `trench` is a DIFFERENT launchpad on the same chain: it has a bonding curve and a graduation step, while pools.fun has neither, so their tokens never overlap.",
  declaration: {
    identity: "pools.fun is a no-curve launchpad whose tokens open directly in a real SushiSwap V3 pool with no graduation step.",
    read: "Browse the pools.fun launchpad and new pools fun launches, search by name or symbol, read price history and full detail for one token, inspect my launches on the Robinhood launchpad, and read creator-fee state.",
    quote: "Preview a launch and its current deployment cost without committing. The preview is advisory and cannot predict the final token address. This namespace has no trading quote; acquiring a token requires a separate trading quote on a swap venue.",
    act: "Open the launch form for a pools fun coin, launch the coin on pools fun now under the applicable authority, or claim my creator fees after a dry-run simulation. It has no buy or sell action.",
    whenItApplies: "Use it to research, vet, launch, or collect fees on a pools.fun token, including first-block launchpad discovery before a general indexer sees the pool.",
    characteristicAndLimits: "Symbols repeat and contract address is identity. Holder count and liquidity are unavailable here, display prices are not executable, and pair research is a separate stage. The deployment cost is dynamic, the agent path requires a staged image, the creator recipient is fixed to the session wallet, and an image-free token can render blank forever.",
    retrievalTerms: [
      "pools.fun launchpad",
      "new pools fun launches",
      "price history",
      "full detail",
      "my launches on the robinhood launchpad",
      "claim my creator fees",
      "open the launch form for a pools fun coin",
      "launch the coin on pools fun now",
      "trading quote",
    ],
    facets: [
      "pools.fun browsing and search",
      "pools.fun candles and token detail",
      "Own pools.fun launches",
      "pools.fun fees to holders",
      "pools.fun launchable stock pairs",
      "Launching a token on pools.fun",
    ],
  },
  exampleQueries: [
    'ToolSearch(query="new pools fun launches", namespace="pools")',
    'ToolSearch(query="pools fun token price history", namespace="pools")',
    'ToolSearch(query="who earns fees on this pools fun token", namespace="pools")',
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
      label: "pools.fun fees to holders",
      summary:
        "Read, claim and push the fees a pools.fun token streams to the wallets that HOLD it. Nothing is staked: "
        + "a token launched with fees-to-holders sends its trading fees to a distributor contract that streams "
        + "them to holders over 24 hours, and the choice is locked at launch. This is a DIFFERENT person's money "
        + "from the creator fees above - those belong to whoever launched the token, these to whoever holds it. "
        + "The claim pays the wallet that signs it and Vex charges nothing for it; the distribute is "
        + "permissionless, pays the holders rather than its caller, and is how a stalled reward stream is "
        + "restarted.",
      toolPrefixes: [
        "pools.holder_rewards",
        "pools.holder_rewards_claim",
        "pools.holder_rewards_distribute",
      ],
      hints: [
        "fees to holders on pools fun",
        "what have I earned holding this coin",
        "claim my holder rewards",
        "does this coin pay its holders",
        "push this token's fees to its holders",
        "trigger the reward distribution",
      ],
    },
    {
      label: "pools.fun launchable stock pairs",
      summary:
        "List the tokenised stocks a new pools.fun coin can be paired with, and how each pair is priced at "
        + "launch. It is its OWN facet rather than a line inside the launching facet above because the "
        + "launching facet's retrieval fields are frozen by owner decision D9, and because the question it "
        + "answers is a menu read that signs nothing: which pairs exist, what each one's contract address is, "
        + "and whether that pair takes its launch price from a feed or from a freshly signed quote that stays "
        + "valid for barely two minutes.",
      toolPrefixes: ["pools.launch_assets"],
      hints: [
        "which stocks can I launch against",
        "pools fun launch pairs",
        "tokenised stocks a new coin can be paired with",
        "is tesla available to pair with on pools fun",
        "which launch pairs need a signed price",
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
