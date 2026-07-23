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
      `Use this when the user wants the price or route as a HIDDEN fallback after KyberSwap reports no route/support, or on Robinhood Chain where $VEX and Virtuals agent tokens trade against VIRTUAL. ` +
      `Example queries: preview uniswap swap on robinhood, best uniswap price for virtual to vex, quote swap on robinhood chain, uniswap route preview. Read-only.`,
    ),
    aliases: ["uniswap quote", "uniswap route preview", "robinhood swap quote", "v2 v3 best route"],
    exampleIntents: ["quote swap on robinhood", "uniswap price VIRTUAL to VEX", "preview uniswap trade"],
    preferredFor: ["uniswap swap quote", "robinhood swap", "route preview", "price impact"],
    chains: UNISWAP_CHAINS,
  },

  "uniswap.swap.execute": {
    embeddingText: embeddingText(
      `Execute a token swap on Uniswap (V2 or V3, best route) — exact-input: spend the input token to receive the output. Execution handles the token approval automatically. ` +
      `Use this when the user wants to swap, sell, buy, dump, or acquire a token as a HIDDEN fallback after KyberSwap reports no route/support, or on Robinhood Chain — trade $VEX or a Virtuals agent token against VIRTUAL/ETH. ` +
      `Example queries: swap vex for virtual on robinhood, sell my robinhood token on uniswap, buy a token via uniswap fallback, execute uniswap trade.`,
    ),
    aliases: ["uniswap execute", "uniswap swap", "trade on robinhood via uniswap", "uniswap fallback swap"],
    exampleIntents: ["swap VEX for VIRTUAL on robinhood via uniswap", "execute uniswap trade", "uniswap fallback execute"],
    preferredFor: ["uniswap swap execute", "robinhood trade", "exact input swap", "kyberswap fallback"],
    chains: UNISWAP_CHAINS,
  },
} satisfies Record<string, ToolDiscoveryMetadata>;

const EXPECTED_COUNT = 2;
if (Object.keys(UNISWAP_SWAP_DISCOVERY).length !== EXPECTED_COUNT) {
  throw new Error(
    `UNISWAP_SWAP_DISCOVERY has ${Object.keys(UNISWAP_SWAP_DISCOVERY).length} entries, expected ${EXPECTED_COUNT}.`,
  );
}
