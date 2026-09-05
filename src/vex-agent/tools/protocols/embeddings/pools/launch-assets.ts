/**
 * Retrieval metadata for the pools.fun launchable-stock list.
 *
 * The passage leads with STOCKS YOU CAN PAIR A NEW COIN WITH, because the
 * nearest neighbours in this space are stock quote and stock trading tools, and
 * this one answers neither: it is the launchpad's menu of pairs plus how each
 * one gets its price at launch.
 */

import type { ToolDiscoveryMetadata } from "../../types.js";
import { embeddingText } from "../../_embedding-text.js";
import { POOLS_CHAINS } from "../../pools/discovery-text.js";

export const POOLS_LAUNCH_ASSETS_DISCOVERY = {
  "pools.launch_assets": {
    embeddingText: embeddingText(
      `List the tokenised stocks a new coin can be paired with when it is created on the pools.fun launchpad on Robinhood Chain. `
      + `Use when choosing what a new coin will be paired with, when planning a launch against a stock, or when asked which stocks the launchpad supports. `
      + `Each row gives the stock symbol, the company name, its address, and how the launchpad prices that pair. `
      + `Most pairs need a freshly signed price valid for barely two minutes. `
      + `The list comes back a page at a time. It signs nothing. `
      + `Example queries: which stocks can I launch against, is tesla available to pair with.`,
    ),
    aliases: [
      "pools fun launchable stocks",
      "launch assets",
      "launch pairs",
      "stocks to pair a launch with",
      "stocks a new coin can be paired with",
      "tokenised stock list",
      "which stocks can I launch against",
    ],
    exampleIntents: [
      "which tokenised stocks can a new coin be paired with on this launchpad",
      "which stocks can I pair a pools fun launch with",
      "is nvidia one of the stocks I can launch against",
      "list the launch pairs that need a signed price at launch",
    ],
    chains: POOLS_CHAINS,
  },
} satisfies Record<string, ToolDiscoveryMetadata>;

const EXPECTED_COUNT = 1;
if (Object.keys(POOLS_LAUNCH_ASSETS_DISCOVERY).length !== EXPECTED_COUNT) {
  throw new Error(
    `POOLS_LAUNCH_ASSETS_DISCOVERY has ${Object.keys(POOLS_LAUNCH_ASSETS_DISCOVERY).length} entries, expected ${EXPECTED_COUNT}.`,
  );
}
