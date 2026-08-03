/**
 * Retrieval metadata for the two Trench LAUNCH tools. English-only passages.
 *
 * The two descriptions are deliberately written to be hard to confuse, because
 * confusing them is the one retrieval error that costs money: `request_form`
 * ASKS a human and spends nothing, `execute` SIGNS. The embedding text for each
 * says which, in those words.
 *
 * HONESTY GATE (Fala B, 2026-08-02): a passage states what the runtime does
 * TODAY, in both directions. Park/resume is now wired, so `request_form` says
 * the turn parks and is resumed with the outcome — the round-3 denial of it is
 * stale. `execute` names the authority matrix as it now stands (owner decrees
 * 2026-08-02): full-permission chat executes directly, restricted refuses and
 * routes to the form, a mission needs host-authored ceilings and refuses by
 * name while its contract carries none. The failure these sentences prevent
 * is a model improvising a launch by another route, whether because it thinks
 * it is stuck or because it thinks it is authorized.
 */

import type { ToolDiscoveryMetadata } from "../../types.js";
import { embeddingText } from "../../_embedding-text.js";
import { TRENCH_CHAINS } from "../../trench/discovery-text.js";

export const TRENCH_LAUNCH_DISCOVERY = {
  "trench.launch_request_form": {
    embeddingText: embeddingText(
      `Ask the user to create a token on the Trench Express launchpad on Robinhood Chain through the launch form, pre-filled with the details you propose. ` +
      `DRAFTS AND ASKS ONLY — it never signs or spends; the user reviews the cost and clicks Deploy. ` +
      `Use this when a human should decide the launch. ` +
      `Your turn parks while the form is open and resumes with the outcome once the user deploys, dismisses it, or it expires; never assume the launch happened without that outcome. ` +
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
      `Create a token on the Trench Express launchpad on Robinhood Chain for real, signed and broadcast from the user's wallet. ` +
      `SPENDS REAL FUNDS and is irreversible: it pays the creation fee and, with a prebuy, buys that much of the token. ` +
      `Vex charges 25 bps of that ETH, transferred separately after the launch confirms. ` +
      `An image is REQUIRED and must already be in the Trench Photos locker. ` +
      `Use this when the session has full permission, or a mission's host-authored ceilings cover it. ` +
      `A restricted session refuses by name: call the launch form, its consent surface. ` +
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
