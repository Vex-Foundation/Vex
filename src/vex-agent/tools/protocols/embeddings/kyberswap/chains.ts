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
  "kyberswap.chains": {
    embeddingText: embeddingText(
      `List the EVM chains where KyberSwap aggregator swaps are available — Ethereum, Base, Arbitrum, BNB Chain, Polygon, Optimism, Avalanche, Linea and others. ` +
      `Use this when the user wants to know what chains and networks KyberSwap currently supports for aggregator swapping and quoting. ` +
      `Example queries: what chains does kyberswap support, list evm networks for swap, does kyberswap work on base, kyberswap chain feature matrix.`,
    ),
    aliases: ["supported networks", "chain ids", "evm chains", "feature matrix"],
    exampleIntents: ["what chains does KyberSwap support", "list swap networks", "show KyberSwap chain ids"],
    chains: KYBER_SWAP_CHAINS,
  },

  "kyberswap.chains.supported": {
    embeddingText: embeddingText(
      `Live availability status for KyberSwap chains — which networks are currently active, inactive, or recently added. ` +
      `Use this when the user wants real-time chain status, asks if a network is up right now, or wants to know about new chain additions before trading. ` +
      `Example queries: is base active on kyberswap right now, live chain status, is the api up for arbitrum, any new chains on kyberswap, kyberswap network availability check.`,
    ),
    aliases: ["live chain status", "network availability", "active chain", "inactive chain"],
    exampleIntents: ["check if base is active", "live KyberSwap chain availability", "network status"],
    chains: KYBER_SWAP_CHAINS,
  },
} satisfies Record<string, ToolDiscoveryMetadata>;

const EXPECTED_COUNT = 2;
if (Object.keys(KYBERSWAP_CHAINS_DISCOVERY).length !== EXPECTED_COUNT) {
  throw new Error(
    `KYBERSWAP_CHAINS_DISCOVERY has ${Object.keys(KYBERSWAP_CHAINS_DISCOVERY).length} entries, expected ${EXPECTED_COUNT}.`,
  );
}
