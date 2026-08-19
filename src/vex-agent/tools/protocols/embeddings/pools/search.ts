/**
 * Retrieval metadata for `pools.search`. Read-only; English-only passage.
 */

import type { ToolDiscoveryMetadata } from "../../types.js";
import { embeddingText } from "../../_embedding-text.js";
import { POOLS_CHAINS } from "../../pools/discovery-text.js";

export const POOLS_SEARCH_DISCOVERY = {
  "pools.search": {
    embeddingText: embeddingText(
      `Look up a coin on the pools.fun launchpad on Robinhood Chain by its name or its symbol. ` +
      `Use this when the user names a coin and you need its address before reading its price history, its full detail, or a trading quote. ` +
      `Results carry the name, symbol, address, pool, the asset it trades against, a display price and market size. ` +
      `Names and symbols repeat here: several live coins can share one symbol, so confirm which one the user means by its address. ` +
      `Example queries: find the pools fun coin called sushicat, look up a coin by symbol on pools fun, resolve a robinhood launchpad ticker.`,
    ),
    aliases: ["pools fun search", "find pools fun token", "pools fun token by symbol", "search robinhood launchpad", "pools fun token lookup"],
    exampleIntents: [
      "find the pools fun coin called sushicat",
      "look up a pools fun token by its symbol",
      "what is the address of this pools fun coin",
    ],
    chains: POOLS_CHAINS,
  },
} satisfies Record<string, ToolDiscoveryMetadata>;

const EXPECTED_COUNT = 1;
if (Object.keys(POOLS_SEARCH_DISCOVERY).length !== EXPECTED_COUNT) {
  throw new Error(
    `POOLS_SEARCH_DISCOVERY has ${Object.keys(POOLS_SEARCH_DISCOVERY).length} entries, expected ${EXPECTED_COUNT}.`,
  );
}
