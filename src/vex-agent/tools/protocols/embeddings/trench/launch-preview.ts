/**
 * Retrieval metadata for `trench.launch_preview`. Read-only dry-run — no
 * mutating action verb. English-only passage.
 */

import type { ToolDiscoveryMetadata } from "../../types.js";
import { embeddingText } from "../../_embedding-text.js";
import { TRENCH_CHAINS } from "../../trench/discovery-text.js";

export const TRENCH_LAUNCH_PREVIEW_DISCOVERY = {
  "trench.launch_preview": {
    embeddingText: embeddingText(
      `Preview what it would take to launch a new token on the Trench Express launchpad on Robinhood Chain, without committing to anything. ` +
      `Use this when the user is thinking about creating a token and wants to check their name, symbol, and links, see the fixed creation fee, and get an estimated total cost before deciding. ` +
      `It validates the inputs and runs an on-chain dry-run to return the token address the launch would produce, the creation fee, and an estimated gas cost. ` +
      `It never signs, spends, or launches. ` +
      `Example queries: preview launching a token on trench, cost to create a trench token, dry run a trench token launch.`,
    ),
    aliases: ["launch preview", "token launch dry run", "create token preview", "estimate launch cost", "trench launch preview"],
    exampleIntents: ["preview launching a token on trench", "how much does it cost to create a token", "dry run a trench token launch"],
    chains: TRENCH_CHAINS,
  },
} satisfies Record<string, ToolDiscoveryMetadata>;

const EXPECTED_COUNT = 1;
if (Object.keys(TRENCH_LAUNCH_PREVIEW_DISCOVERY).length !== EXPECTED_COUNT) {
  throw new Error(
    `TRENCH_LAUNCH_PREVIEW_DISCOVERY has ${Object.keys(TRENCH_LAUNCH_PREVIEW_DISCOVERY).length} entries, expected ${EXPECTED_COUNT}.`,
  );
}
