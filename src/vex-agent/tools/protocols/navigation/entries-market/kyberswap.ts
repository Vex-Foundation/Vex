import type { ProtocolNamespaceNavigation } from "../types.js";
import { getKyberChains } from "@tools/kyberswap/chains.js";

/**
 * Swap-supported EVM chain slugs for the kyberswap entry's `summary`,
 * derived from the LIVE registry at module load (owner add-on, 2026-07-23) —
 * never hand-written, so a future chain add/drop in `@tools/kyberswap/chains.ts`
 * flows into the built protocols prompt automatically. Filtered to
 * `aggregator: true` (the feature `kyberswap.swap.execute` actually needs),
 * not just "every registry entry," so a hypothetical future chain added for a
 * different feature without aggregator support is correctly excluded. Kept
 * reveal-consistent (Agent Scan plan v3 §11.2 / C30): this line names ONLY
 * KyberSwap chains — it must never mention Uniswap; the existing "if
 * KyberSwap cannot route, a backup venue is offered automatically in the
 * failure message" wording already covers the off-registry case.
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
    "KyberSwap is the PRIMARY EVM swap route: use `uniswap` when KyberSwap has no aggregator support for the chain or cannot route the pair, `khalani` to resolve token addresses across chains or to bridge between them, `solana` for Solana trading, and `dexscreener` for read-only research.",
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
