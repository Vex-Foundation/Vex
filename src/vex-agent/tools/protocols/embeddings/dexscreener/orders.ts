/**
 * Retrieval metadata for DexScreener orders tools.
 *
 * Source-of-truth for both the lexical scorer (`discovery.ts`) and the
 * future dense-retrieval pipeline (EmbeddingGemma 300M → pgvector). Manifest
 * at `dexscreener/manifests/orders.ts` references entries by `toolId`.
 */

import type { ToolDiscoveryMetadata } from "../../types.js";
import { embeddingText } from "../../_embedding-text.js";
import { DEXSCREENER_CHAINS } from "../../dexscreener/discovery-text.js";

export const DEXSCREENER_ORDERS_DISCOVERY = {
  "dexscreener.orders": {
    embeddingText: embeddingText(
      `Check whether a token has paid promotional orders on DEX Screener — type, status, payment timestamp. ` +
      `Use this when the user wants to know whether a token is being marketed, review a project's marketing history, or see how much money is being spent to promote a coin — a spend record, never a safety verdict. ` +
      `Example queries: is this token paying for promo, marketing campaign for this coin, paid promo history for token, has this project bought ads, promo orders for this token.`,
    ),
    chains: DEXSCREENER_CHAINS,
  },
  "dexscreener.ads": {
    embeddingText: embeddingText(
      `Get the latest ad placements running on DEX Screener — what tokens are paying for visibility right now, ad type, duration. ` +
      `Use this when the user wants to see who is currently advertising on the platform, what new tokens are buying attention, or which projects are spending on visibility. ` +
      `Example queries: who is advertising on dexscreener, latest token ads, current promo placements, what's being marketed right now, who's spending on ads.`,
    ),
    chains: DEXSCREENER_CHAINS,
  },
} satisfies Record<string, ToolDiscoveryMetadata>;

const EXPECTED_COUNT = 2;
if (Object.keys(DEXSCREENER_ORDERS_DISCOVERY).length !== EXPECTED_COUNT) {
  throw new Error(
    `DEXSCREENER_ORDERS_DISCOVERY has ${Object.keys(DEXSCREENER_ORDERS_DISCOVERY).length} entries, expected ${EXPECTED_COUNT}.`,
  );
}
