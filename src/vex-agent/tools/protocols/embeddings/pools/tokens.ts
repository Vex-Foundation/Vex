/**
 * Retrieval metadata for `pools.tokens`.
 *
 * Source-of-truth for the lexical scorer and the dense-retrieval pipeline; the
 * manifest at `pools/manifests/tokens.ts` references it by toolId. Read-only, so
 * no mutating action verb is required. Passage is English-only and free of
 * technical jargon per the embedding-text style linter.
 */

import type { ToolDiscoveryMetadata } from "../../types.js";
import { embeddingText } from "../../_embedding-text.js";
import { POOLS_CHAINS } from "../../pools/discovery-text.js";

export const POOLS_TOKENS_DISCOVERY = {
  "pools.tokens": {
    embeddingText: embeddingText(
      `Browse the pools.fun launchpad on Robinhood Chain and screen the coins launched there. ` +
      `Use when exploring or ranking these launches: what appeared in the last few hours, what is trading hardest right now, every coin one wallet made, or coins inside a size range. ` +
      `Each row carries the name, symbol, address, pool, the asset it trades against, a display price, market size, volume, trade count, price moves, age, and who launched it and who earns its fees. ` +
      `There is no bonding curve here and nothing graduates. ` +
      `Example queries: new pools fun launches, fresh coins on robinhood, pools fun coins with the most volume today, coins launched by this wallet.`,
    ),
    aliases: ["pools fun tokens", "pools.fun launchpad", "robinhood launchpad tokens", "new pools fun launches", "sushi launchpad tokens"],
    exampleIntents: [
      "new token launches on pools fun",
      "fresh pools fun launches in the last hour",
      "pools fun coins with the most volume",
      "screen robinhood launchpad tokens by market size",
    ],
    chains: POOLS_CHAINS,
  },
} satisfies Record<string, ToolDiscoveryMetadata>;

const EXPECTED_COUNT = 1;
if (Object.keys(POOLS_TOKENS_DISCOVERY).length !== EXPECTED_COUNT) {
  throw new Error(
    `POOLS_TOKENS_DISCOVERY has ${Object.keys(POOLS_TOKENS_DISCOVERY).length} entries, expected ${EXPECTED_COUNT}.`,
  );
}
