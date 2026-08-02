/**
 * Retrieval metadata for `trench.trades`. Read-only; English-only passage.
 */

import type { ToolDiscoveryMetadata } from "../../types.js";
import { embeddingText } from "../../_embedding-text.js";
import { TRENCH_CHAINS } from "../../trench/discovery-text.js";

export const TRENCH_TRADES_DISCOVERY = {
  "trench.trades": {
    embeddingText: embeddingText(
      `Read the recent trade tape for one Trench Express launchpad token on Robinhood Chain — the running list of buys and sells against its bonding curve. ` +
      `Use this when the user wants the activity on a specific token: who is buying or selling, how large the recent fills are, and the USD volume behind each trade. ` +
      `Each entry carries the buy-or-sell direction, the amounts traded, a USD volume, a price, a transaction hash, a timestamp, and the trader. ` +
      `Example queries: recent trades for this trench token, buy and sell activity on a launchpad token, who is trading this token, latest fills on the curve, trade tape for trench.`,
    ),
    aliases: ["trench trades", "token trade tape", "launchpad token activity", "recent trades", "buy sell activity"],
    exampleIntents: ["recent trades for this trench token", "buy and sell activity on a launchpad token", "who is trading this token"],
    chains: TRENCH_CHAINS,
  },
} satisfies Record<string, ToolDiscoveryMetadata>;

const EXPECTED_COUNT = 1;
if (Object.keys(TRENCH_TRADES_DISCOVERY).length !== EXPECTED_COUNT) {
  throw new Error(
    `TRENCH_TRADES_DISCOVERY has ${Object.keys(TRENCH_TRADES_DISCOVERY).length} entries, expected ${EXPECTED_COUNT}.`,
  );
}
