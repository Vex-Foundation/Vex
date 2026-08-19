/**
 * Retrieval metadata for `pools.token`. Read-only; English-only passage.
 */

import type { ToolDiscoveryMetadata } from "../../types.js";
import { embeddingText } from "../../_embedding-text.js";
import { POOLS_CHAINS } from "../../pools/discovery-text.js";

export const POOLS_TOKEN_DISCOVERY = {
  "pools.token": {
    embeddingText: embeddingText(
      `Read the full detail of one coin on the pools.fun launchpad on Robinhood Chain, joining what the launchpad reports with what the contracts themselves say. ` +
      `Use when about to act on a coin and needing to confirm which pool is really its pool, who created it, who collects its fees and how those fees are shared, and how many decimal places it has. ` +
      `The reply separates the launchpad figures, which are for display, from values read straight from the chain at one recorded block. ` +
      `Example queries: full detail on this pools fun coin, who earns the fees on this token, which pool does this coin trade in.`,
    ),
    aliases: ["pools fun token detail", "who created this pools fun coin", "pools fun fee split", "pools fun pool address", "pools fun token decimals"],
    exampleIntents: [
      "full detail on this pools fun coin",
      "who earns the fees on this pools fun token",
      "which pool does this pools fun coin trade in",
    ],
    chains: POOLS_CHAINS,
  },
} satisfies Record<string, ToolDiscoveryMetadata>;

const EXPECTED_COUNT = 1;
if (Object.keys(POOLS_TOKEN_DISCOVERY).length !== EXPECTED_COUNT) {
  throw new Error(
    `POOLS_TOKEN_DISCOVERY has ${Object.keys(POOLS_TOKEN_DISCOVERY).length} entries, expected ${EXPECTED_COUNT}.`,
  );
}
