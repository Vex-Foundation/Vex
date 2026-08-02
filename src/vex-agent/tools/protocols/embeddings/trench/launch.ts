/**
 * Retrieval metadata for the two Trench LAUNCH tools. English-only passages.
 *
 * The two descriptions are deliberately written to be hard to confuse, because
 * confusing them is the one retrieval error that costs money: `request_form`
 * ASKS a human and spends nothing, `execute` SIGNS. The embedding text for each
 * says which, in those words.
 */

import type { ToolDiscoveryMetadata } from "../../types.js";
import { embeddingText } from "../../_embedding-text.js";
import { TRENCH_CHAINS } from "../../trench/discovery-text.js";

export const TRENCH_LAUNCH_DISCOVERY = {
  "trench.launch_request_form": {
    embeddingText: embeddingText(
      `Ask the user to create a token on the Trench Express launchpad on Robinhood Chain by opening the launch form, pre-filled with the name, symbol, description, links and image you propose. ` +
      `DRAFTS AND ASKS ONLY — it never signs or spends; the user reviews the details, sees the cost, and clicks Deploy. ` +
      `Use this when a human should decide the launch, or when you are not running with full autonomy. ` +
      `Your turn pauses while the form is open and resumes once the user deploys or dismisses it. ` +
      `Example queries: launch a token for me, create a coin called X, make me a memecoin, open the launch form.`,
    ),
    aliases: [
      "ask to launch a token",
      "open the launch form",
      "propose a token launch",
      "create a coin with the user's approval",
    ],
    exampleIntents: [
      "launch a token called Vex",
      "create a memecoin for me",
      "I want to deploy a coin on trench",
    ],
    operation: ["execute"],
    sideEffectLevel: "none",
    chains: TRENCH_CHAINS,
  },
  "trench.launch_execute": {
    embeddingText: embeddingText(
      `Create a token on the Trench Express launchpad on Robinhood Chain for real, signing and broadcasting with the user's own wallet. ` +
      `SPENDS REAL FUNDS and is irreversible: it pays the creation fee and, with a prebuy, buys that much of the token on its curve in the same transaction. ` +
      `An image is REQUIRED and must already be in the Trench Photos locker — it is written on-chain at creation and can never be added later. ` +
      `Use this when authorized: full autonomy executes directly, bounded by the mission's value and count ceilings; otherwise it needs an approval first. ` +
      `Example queries: launch it now, deploy the token, go ahead and create it.`,
    ),
    aliases: ["deploy the token", "execute the launch", "create the token now", "launch it for real"],
    exampleIntents: ["launch it now", "deploy the token", "go ahead and create the coin"],
    operation: ["execute"],
    sideEffectLevel: "high",
    chains: TRENCH_CHAINS,
  },
} satisfies Record<string, ToolDiscoveryMetadata>;

const EXPECTED_COUNT = 2;
if (Object.keys(TRENCH_LAUNCH_DISCOVERY).length !== EXPECTED_COUNT) {
  throw new Error(
    `TRENCH_LAUNCH_DISCOVERY has ${Object.keys(TRENCH_LAUNCH_DISCOVERY).length} entries, expected ${EXPECTED_COUNT}.`,
  );
}
