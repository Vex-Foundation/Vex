/**
 * Retrieval metadata for `trench.my_launches`. Read-only; English-only passage.
 */

import type { ToolDiscoveryMetadata } from "../../types.js";
import { embeddingText } from "../../_embedding-text.js";
import { TRENCH_CHAINS } from "../../trench/discovery-text.js";

export const TRENCH_MY_LAUNCHES_DISCOVERY = {
  "trench.my_launches": {
    embeddingText: embeddingText(
      `List the tokens you launched yourself on the Trench Express launchpad on Robinhood Chain — Vex's own durable record of every token it created for you. ` +
      `Use when the user asks what they have launched, wants to revisit a coin they created earlier, or needs the contract address or creation transaction of one of their own launches. ` +
      `Each entry carries the token address, its name and symbol, the transaction that created it, when it launched, and the size of any initial buy made in the same transaction. ` +
      `Example queries: what tokens have I launched, show my trench launches, my created coins, the address of the token I made, my launch history.`,
    ),
    aliases: ["my launches", "tokens I launched", "my created tokens", "launch history", "coins I made"],
    exampleIntents: [
      "what tokens have I launched",
      "show my trench launches",
      "the address of the token I made",
    ],
    chains: TRENCH_CHAINS,
  },
} satisfies Record<string, ToolDiscoveryMetadata>;

const EXPECTED_COUNT = 1;
if (Object.keys(TRENCH_MY_LAUNCHES_DISCOVERY).length !== EXPECTED_COUNT) {
  throw new Error(
    `TRENCH_MY_LAUNCHES_DISCOVERY has ${Object.keys(TRENCH_MY_LAUNCHES_DISCOVERY).length} entries, expected ${EXPECTED_COUNT}.`,
  );
}
