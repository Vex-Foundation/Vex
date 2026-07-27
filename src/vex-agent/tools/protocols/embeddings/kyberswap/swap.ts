/**
 * Retrieval metadata for KyberSwap swap tools.
 *
 * Source-of-truth for both the lexical scorer (`discovery.ts`) and the
 * future dense-retrieval pipeline (EmbeddingGemma 300M → pgvector). Manifest
 * at `kyberswap/manifests/swap.ts` references entries by `toolId`.
 */

import type { ToolDiscoveryMetadata } from "../../types.js";
import { embeddingText } from "../../_embedding-text.js";
import { KYBER_SWAP_CHAINS } from "../../kyberswap/discovery-text.js";

export const KYBERSWAP_SWAP_DISCOVERY = {
  "kyberswap.swap.quote": {
    embeddingText: embeddingText(
      `Preview a token swap on Ethereum, Base, Arbitrum, BNB Chain, Polygon, Optimism, Avalanche and other EVM chains — get the output amount, route, gas cost, price impact, and slippage before executing. ` +
      `Use this when the user wants to know the best price, check the rate before swapping, simulate a trade, or compare what they'd get for a swap. ` +
      `Example queries: how much usdc do I get for 1 eth on base, best price for swap, preview trade, what would I get for selling pepe, check the rate on bnb. ` +
      `Read-only — does not execute.`,
    ),
    aliases: ["swap quote", "route preview", "best route", "price impact", "slippage preview", "RFQ liquidity"],
    exampleIntents: ["quote swap on bnb", "best route USDC to ETH on base", "preview token swap"],
    chains: KYBER_SWAP_CHAINS,
  },

  "kyberswap.swap.execute": {
    embeddingText: embeddingText(
      `Execute a real on-chain swap on Ethereum, Base, Arbitrum, BNB Chain, Polygon, Optimism, Avalanche and other EVM chains — exact-input, routes through 400+ DEXes for the best price. ` +
      `Use this when the user wants to buy or sell a coin, ape into a memecoin, exit a position, dump a holding, swap one token for another, or acquire a token with stables. ` +
      `Example queries: swap eth for usdc on base, buy pepe with usdc, sell my doge, exit my shitcoin position, ape into this memecoin, acquire some link. ` +
      `Requires a fresh matching kyberswap.swap.quote first.`,
    ),
    aliases: ["execute swap", "sell token", "buy token", "swap out", "exit position", "acquire token"],
    exampleIntents: ["swap ETH for USDC on arbitrum", "buy token on bnb", "exit token position on base"],
    chains: KYBER_SWAP_CHAINS,
  },
} satisfies Record<string, ToolDiscoveryMetadata>;

const EXPECTED_COUNT = 2;
if (Object.keys(KYBERSWAP_SWAP_DISCOVERY).length !== EXPECTED_COUNT) {
  throw new Error(
    `KYBERSWAP_SWAP_DISCOVERY has ${Object.keys(KYBERSWAP_SWAP_DISCOVERY).length} entries, expected ${EXPECTED_COUNT}.`,
  );
}
