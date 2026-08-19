/**
 * Retrieval metadata for `pools.my_launches`. Read-only; English-only passage.
 */

import type { ToolDiscoveryMetadata } from "../../types.js";
import { embeddingText } from "../../_embedding-text.js";
import { POOLS_CHAINS } from "../../pools/discovery-text.js";

export const POOLS_MY_LAUNCHES_DISCOVERY = {
  "pools.my_launches": {
    embeddingText: embeddingText(
      `List the coins the user's own wallet launched on the pools.fun launchpad on Robinhood Chain. ` +
      `Use when the user asks what they have launched there, wants to revisit a coin they made, or needs the address of one of their own. ` +
      `Each entry carries the address, name, symbol, pool, a display price and market size, when it launched, and a mark saying it is their own. ` +
      `The wallet is the one selected for the session and cannot be pointed at somebody else. ` +
      `Example queries: what have I launched on pools fun, show my pools fun coins, the address of the coin I made, my launches on the robinhood launchpad.`,
    ),
    aliases: ["my pools fun launches", "coins I launched on pools fun", "my created pools fun tokens", "my robinhood launchpad coins", "pools fun launch history"],
    exampleIntents: [
      "what have I launched on pools fun",
      "show my pools fun coins",
      "the address of the pools fun coin I made",
    ],
    chains: POOLS_CHAINS,
  },
} satisfies Record<string, ToolDiscoveryMetadata>;

const EXPECTED_COUNT = 1;
if (Object.keys(POOLS_MY_LAUNCHES_DISCOVERY).length !== EXPECTED_COUNT) {
  throw new Error(
    `POOLS_MY_LAUNCHES_DISCOVERY has ${Object.keys(POOLS_MY_LAUNCHES_DISCOVERY).length} entries, expected ${EXPECTED_COUNT}.`,
  );
}
