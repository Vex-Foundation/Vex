/**
 * Retrieval metadata for `pools.candles`. Read-only; English-only passage.
 */

import type { ToolDiscoveryMetadata } from "../../types.js";
import { embeddingText } from "../../_embedding-text.js";
import { POOLS_CHAINS } from "../../pools/discovery-text.js";

export const POOLS_CANDLES_DISCOVERY = {
  "pools.candles": {
    embeddingText: embeddingText(
      `Read the price history of one coin on the pools.fun launchpad on Robinhood Chain. ` +
      `Use when analysing how a coin has traded: choose how long each bar covers, from a minute up to a day and any multiple in between, and how many bars to read. ` +
      `Each bar carries its time, its opening, highest, lowest and closing price, and the money traded during it. ` +
      `The reply names the asset the prices are quoted against and which end of the list is newest. ` +
      `Example queries: price history of this pools fun coin, hourly chart for a robinhood launchpad coin, five minute bars for this token, how has this coin moved today.`,
    ),
    aliases: ["pools fun price history", "pools fun chart", "robinhood launchpad candles", "price bars for a pools fun coin", "pools fun ohlc"],
    exampleIntents: [
      "price history of this pools fun coin",
      "hourly chart for a pools fun token",
      "how has this robinhood launchpad coin moved today",
    ],
    chains: POOLS_CHAINS,
  },
} satisfies Record<string, ToolDiscoveryMetadata>;

const EXPECTED_COUNT = 1;
if (Object.keys(POOLS_CANDLES_DISCOVERY).length !== EXPECTED_COUNT) {
  throw new Error(
    `POOLS_CANDLES_DISCOVERY has ${Object.keys(POOLS_CANDLES_DISCOVERY).length} entries, expected ${EXPECTED_COUNT}.`,
  );
}
