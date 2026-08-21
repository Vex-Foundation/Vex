/**
 * Retrieval metadata for KyberSwap chains tools.
 *
 * Source-of-truth for both the lexical scorer (`discovery.ts`) and the
 * future dense-retrieval pipeline (EmbeddingGemma 300M → pgvector). Manifest
 * at `kyberswap/manifests/chains.ts` references entries by `toolId`.
 */

import type { ToolDiscoveryMetadata } from "../../types.js";
import { embeddingText } from "../../_embedding-text.js";
import { KYBER_SWAP_CHAINS } from "../../kyberswap/discovery-text.js";

export const KYBERSWAP_CHAINS_DISCOVERY = {
  // ONE entry since the chains merge (`kyberswap.chains.supported` retired into
  // this tool's `liveStatus` param): the live-status intents below used to
  // reach a second tool one suffix away, so they are carried here rather than
  // deleted with it.
  "kyberswap.chains": {
    embeddingText: embeddingText(
      `List the EVM chains where KyberSwap aggregator swaps are available - Ethereum, Base, Arbitrum, BNB Chain, Polygon, Optimism, Avalanche, Linea and others - each with the chain slug every other kyberswap call needs. ` +
      `Use this when the user wants to know what chains and networks KyberSwap currently supports for aggregator swapping and quoting, and set liveStatus to also read whether each chain is active, inactive or new right now. ` +
      `Example queries: what chains does kyberswap support, list evm networks for swap, does kyberswap work on base, kyberswap chain feature matrix, is base active on kyberswap right now, live chain status, any new chains on kyberswap, kyberswap network availability check.`,
    ),
    aliases: [
      "supported networks",
      "chain ids",
      "evm chains",
      "feature matrix",
      "live chain status",
      "network availability",
      "active chain",
      "inactive chain",
    ],
    exampleIntents: [
      "what chains does KyberSwap support",
      "list swap networks",
      "show KyberSwap chain ids",
      "check if base is active",
      "live KyberSwap chain availability",
    ],
    chains: KYBER_SWAP_CHAINS,
  },
} satisfies Record<string, ToolDiscoveryMetadata>;

const EXPECTED_COUNT = 1;
if (Object.keys(KYBERSWAP_CHAINS_DISCOVERY).length !== EXPECTED_COUNT) {
  throw new Error(
    `KYBERSWAP_CHAINS_DISCOVERY has ${Object.keys(KYBERSWAP_CHAINS_DISCOVERY).length} entries, expected ${EXPECTED_COUNT}.`,
  );
}
