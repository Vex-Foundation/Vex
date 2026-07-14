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
      `Preview a token swap on Uniswap across V2 and V3 pools — best route, expected output, price impact, gas, and token-safety signals — before executing. ` +
      `Use this when the user wants the price or route as an all-EVM fallback when KyberSwap is unavailable, or on Robinhood Chain where $VEX and Virtuals agent tokens trade against VIRTUAL. ` +
      `Example queries: preview uniswap swap on robinhood, best uniswap price for virtual to vex, quote swap on robinhood chain, uniswap route preview. Read-only.`,
    ),
    aliases: ["uniswap quote", "uniswap route preview", "robinhood swap quote", "v2 v3 best route"],
    exampleIntents: ["quote swap on robinhood", "uniswap price VIRTUAL to VEX", "preview uniswap trade"],
    preferredFor: ["uniswap swap quote", "robinhood swap", "route preview", "price impact"],
    chains: UNISWAP_CHAINS,
  },

  "uniswap.swap.sell": {
    embeddingText: embeddingText(
      `Sell a token on Uniswap (V2 or V3, best route) — exact-input swap: spend the input token to receive the output. Execution handles the token approval automatically. ` +
      `Use this when the user wants to sell, dump, or exit a position as an all-EVM fallback for KyberSwap, or on Robinhood Chain — sell $VEX or a Virtuals agent token for VIRTUAL/ETH. ` +
      `Example queries: sell vex for virtual on robinhood, dump my robinhood token, exit position on uniswap, swap out on robinhood chain.`,
    ),
    aliases: ["uniswap sell", "sell on robinhood", "exit position uniswap", "swap out uniswap"],
    exampleIntents: ["sell VEX for VIRTUAL on robinhood", "uniswap sell token", "exit robinhood position"],
    preferredFor: ["uniswap sell", "robinhood sell", "exit position", "exact input swap"],
    chains: UNISWAP_CHAINS,
  },

  "uniswap.swap.buy": {
    embeddingText: embeddingText(
      `Buy a token on Uniswap (V2 or V3, best route) — exact-input swap marked as a buy for portfolio tracking (a lot opens on the output token). Execution handles the token approval automatically. ` +
      `Use this when the user wants to buy, ape into, or acquire a token as an all-EVM fallback for KyberSwap, or on Robinhood Chain — buy $VEX or a Virtuals agent token with VIRTUAL/ETH. ` +
      `Example queries: buy vex with virtual on robinhood, ape into a robinhood token, acquire token on uniswap, open a spot position on robinhood chain.`,
    ),
    aliases: ["uniswap buy", "buy on robinhood", "acquire token uniswap", "ape robinhood"],
    exampleIntents: ["buy VEX with VIRTUAL on robinhood", "uniswap buy token", "open robinhood position"],
    preferredFor: ["uniswap buy", "robinhood buy", "open spot position", "exact input swap"],
    chains: UNISWAP_CHAINS,
  },
} satisfies Record<string, ToolDiscoveryMetadata>;

const EXPECTED_COUNT = 3;
if (Object.keys(UNISWAP_SWAP_DISCOVERY).length !== EXPECTED_COUNT) {
  throw new Error(
    `UNISWAP_SWAP_DISCOVERY has ${Object.keys(UNISWAP_SWAP_DISCOVERY).length} entries, expected ${EXPECTED_COUNT}.`,
  );
}
