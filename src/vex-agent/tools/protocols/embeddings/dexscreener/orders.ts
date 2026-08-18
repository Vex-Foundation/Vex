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
      `Use this when the exact chain and token address are known, after a boost or ad lookup, to read that token's DexScreener promotion-order record. It is never evidence of demand, legitimacy, or contract safety. ` +
      `Example queries: is this token paying for promo, marketing campaign for this coin, paid promo history for token, has this project bought ads, promo orders for this token.`,
    ),
    aliases: [
      "promotion orders for this exact token",
      "promotion orders",
      "paid promo orders",
      "token promotion record",
    ],
    exampleIntents: [
      "promotion orders for this exact token",
      "check promotion orders for this exact token",
      "show this token's paid promo order status",
    ],
    chains: DEXSCREENER_CHAINS,
  },
  "dexscreener.ads": {
    embeddingText: embeddingText(
      `Get the latest ad placements running on DEX Screener — what tokens are paying for visibility right now, ad type, duration. ` +
      `Use this when the user wants DexScreener's current ad-placement labels, then call dexscreener.orders for one selected exact token. An ad is paid visibility, not proof of demand, legitimacy, or safety. ` +
      `Example queries: who is advertising on dexscreener, latest token ads, current promo placements, what's being marketed right now, who's spending on ads.`,
    ),
    aliases: ["token ad placements", "current dexscreener ads", "paid token ads"],
    exampleIntents: [
      "show current token ad placements",
      "which tokens have paid ads on dexscreener",
    ],
    chains: DEXSCREENER_CHAINS,
  },
} satisfies Record<string, ToolDiscoveryMetadata>;

const EXPECTED_COUNT = 2;
if (Object.keys(DEXSCREENER_ORDERS_DISCOVERY).length !== EXPECTED_COUNT) {
  throw new Error(
    `DEXSCREENER_ORDERS_DISCOVERY has ${Object.keys(DEXSCREENER_ORDERS_DISCOVERY).length} entries, expected ${EXPECTED_COUNT}.`,
  );
}
