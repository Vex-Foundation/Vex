/**
 * Retrieval metadata for Uniswap swap tools.
 *
 * Source-of-truth for the lexical scorer and the dense-retrieval pipeline.
 * Manifest at `uniswap/manifests/swap.ts` references entries by `toolId`. Vectors
 * are (re)built by the boot reconcile / `tool-reembed`; passages live in code.
 */

import type { ToolDiscoveryMetadata } from "../../types.js";
import { embeddingText } from "../../_embedding-text.js";
import { UNISWAP_CHAINS } from "../../uniswap/discovery-text.js";

export const UNISWAP_SWAP_DISCOVERY = {
  "uniswap.swap.quote": {
    embeddingText: embeddingText(
      `Preview a token swap on Ethereum, Base, Arbitrum, Optimism, Polygon, BNB Chain and Robinhood Chain, priced straight against Uniswap V2, V3 and v4 pools - get the expected output, the best route across the pool versions, price impact, gas and token-safety signals. ` +
      `Use this when the user wants the price, the rate before swapping, what a trade would return, or a pair an aggregator does not cover, including Robinhood Chain where $VEX and Virtuals agent tokens trade against VIRTUAL. ` +
      `Example queries: how much usdc do I get for 1 eth on base, best price for a swap, route preview, quote swap on robinhood chain. ` +
      `Read-only - does not execute.`,
    ),
    aliases: ["swap quote", "route preview", "best price", "price impact", "v2 v3 pool route", "robinhood swap quote"],
    exampleIntents: ["quote a swap on base", "best price USDC to ETH on arbitrum", "preview token swap"],
    chains: UNISWAP_CHAINS,
  },

  "uniswap.swap.execute": {
    embeddingText: embeddingText(
      `Execute a real on-chain swap on Ethereum, Base, Arbitrum, Optimism, Polygon, BNB Chain and Robinhood Chain - exact-input, priced straight against Uniswap V2, V3 and v4 pools, with the token approval handled automatically. ` +
      `Use this when the user wants to buy or sell a coin, ape into a memecoin, exit a position, dump a holding, or trade a pair an aggregator does not cover, including $VEX or a Virtuals agent token against VIRTUAL/ETH on Robinhood Chain. ` +
      `Example queries: swap eth for usdc on base, buy this token with usdc, sell my position, exit a holding, swap vex for virtual on robinhood. ` +
      `Requires a fresh matching uniswap swap quote first.`,
    ),
    aliases: ["execute swap", "sell token", "buy token", "swap out", "exit position", "trade on robinhood"],
    exampleIntents: ["swap ETH for USDC on base", "buy a token on arbitrum", "swap VEX for VIRTUAL on robinhood"],
    chains: UNISWAP_CHAINS,
  },
} satisfies Record<string, ToolDiscoveryMetadata>;

const EXPECTED_COUNT = 2;
if (Object.keys(UNISWAP_SWAP_DISCOVERY).length !== EXPECTED_COUNT) {
  throw new Error(
    `UNISWAP_SWAP_DISCOVERY has ${Object.keys(UNISWAP_SWAP_DISCOVERY).length} entries, expected ${EXPECTED_COUNT}.`,
  );
}
