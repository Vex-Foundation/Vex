import type { ProtocolNamespaceNavigation } from "../types.js";
import { ROBINHOOD_SWAP_VENUE_GUIDANCE, SWAP_VENUE_STANDING } from "@vex-agent/tools/registry/swap-venue-guidance.js";
import { getKyberChains } from "@tools/kyberswap/chains.js";

/**
 * Swap-supported EVM chain slugs for the kyberswap entry's `summary`,
 * derived from the LIVE registry at module load (owner add-on, 2026-07-23) -
 * never hand-written, so a future chain add/drop in `@tools/kyberswap/chains.ts`
 * flows into the built protocols prompt automatically. Filtered to
 * `aggregator: true` (the feature `kyberswap.swap.execute` actually needs),
 * not just "every registry entry," so a hypothetical future chain added for a
 * different feature without aggregator support is correctly excluded. This line
 * names ONLY KyberSwap chains: it is this venue's own coverage, and the other
 * venue's coverage is stated by that venue. The standing between the two is
 * owned by `registry/swap-venue-guidance.ts` and imported below, never
 * restated here.
 */
const KYBER_SWAP_EXECUTE_CHAIN_SLUGS: readonly string[] = getKyberChains()
  .filter((chain) => chain.aggregator)
  .map((chain) => chain.slug);

export const KYBERSWAP_NAVIGATION: ProtocolNamespaceNavigation = {
  namespace: "kyberswap",
  advertised: true,
  groupId: "evm-trading",
  groupLabel: "EVM Trading",
  summary: `The aggregator Vex swaps EVM tokens through: one exact-input trade routed across 400+ DEXes for the best price, quoted before it is signed, plus a honeypot and fee-on-transfer safety check on any EVM token. Swap-supported EVM chains: ${KYBER_SWAP_EXECUTE_CHAIN_SLUGS.join(", ")}.`,
  whenToUse:
    "Use when the user wants to buy, sell, swap or exit a token on an EVM chain, wants the rate, route, gas cost or price impact before trading, or wants a token checked for honeypot or fee-on-transfer behaviour. Quote first, then execute with the same params.",
  preferInstead:
    `${SWAP_VENUE_STANDING} Reach for \`khalani\` to resolve token addresses across chains or to bridge between them, \`solana\` for Solana trading, and \`dexscreener\` for read-only research.`,
  declaration: {
    identity: "KyberSwap is an EVM swap aggregator that routes exact-input trades across more than 400 decentralized exchanges.",
    read: "Read EVM chains, the feature matrix, live chain status, token metadata and a honeypot/fee-on-transfer safety check.",
    quote: "Preview a token swap: best price, route, output, gas estimate, price impact, slippage and both tokens' safety results; no signing.",
    act: "Buy, sell, swap or exit a position after a fresh quote with identical parameters. The wallet signs and broadcasts; it can confirm, spend gas and revert, refuse before signing, or stay pending.",
    whenItApplies: ROBINHOOD_SWAP_VENUE_GUIDANCE,
    characteristicAndLimits: "Quotes and chain state can go stale; routes are not guaranteed. Raw amounts are base units; summaries use human units. Safety signals are evidence, not guarantees. Robinhood support is provisional; rate limits are unquantified.",
    retrievalTerms: [
      "EVM chains",
      "feature matrix",
      "live chain status",
      "preview a token swap",
      "best price",
      "price impact",
      "slippage",
      "exit a position",
      "safety check",
      "honeypot",
      "fee-on-transfer",
    ],
    facets: ["Chains and token safety", "Swaps"],
  },
  exampleQueries: [
    'ToolSearch(query="swap on base", namespace="kyberswap")',
    'ToolSearch(query="check token honeypot", namespace="kyberswap")',
  ],
  aliases: ["kyber", "evm swap", "honeypot check"],
  discoveryHints: ["swap on ethereum", "honeypot check", "fee on transfer"],
  facets: [
    {
      label: "Chains and token safety",
      summary: "Inspect supported chains, search token metadata, and run honeypot/FOT safety checks.",
      toolPrefixes: ["kyberswap.chains", "kyberswap.tokens"],
      hints: ["supported evm chains", "token search", "honeypot", "fee on transfer"],
    },
    {
      label: "Swaps",
      summary: "Quote or execute routed swaps on EVM chains after token resolution.",
      toolPrefixes: ["kyberswap.swap"],
      hints: ["swap quote", "sell token", "buy token", "route build"],
    },
  ],
};
