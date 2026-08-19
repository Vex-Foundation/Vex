/**
 * Retrieval metadata for the pools.fun launch tools.
 *
 * Written to be hard to confuse with the Trench launch tools, which are the
 * nearest neighbours in this space: both launch a coin on the same chain from
 * the same app. The differentiator leads each passage - pools.fun coins open
 * directly into a real trading pool against ETH or a dollar token, with no
 * bonding curve to climb - because a passage that opens with the shared idea
 * ("launch a coin") is a passage the retriever cannot separate.
 */

import type { ToolDiscoveryMetadata } from "../../types.js";
import { embeddingText } from "../../_embedding-text.js";
import { POOLS_CHAINS } from "../../pools/discovery-text.js";

export const POOLS_LAUNCH_DISCOVERY = {
  "pools.launch_preview": {
    embeddingText: embeddingText(
      `Create a costed preview of a new pools.fun coin on Robinhood Chain, where a coin opens straight into a real trading pool rather than climbing a curve. ` +
      `Use when someone is weighing up making a coin and wants the cost first: the launch charge, an optional first buy, and the platform share, each as an exact amount. ` +
      `The reply is an estimate, because the final address depends on the picture and is fixed only when the launch is prepared for real. ` +
      `Nothing is spent or signed. ` +
      `Example queries: what would it cost to make a coin on pools fun, price a pools fun launch.`,
    ),
    aliases: ["pools fun launch cost", "price a pools fun launch", "cost to make a coin on pools fun", "pools fun launch estimate"],
    exampleIntents: [
      "what would it cost to launch a coin on pools fun",
      "price a pools fun launch with a first buy",
      "how much does a pools fun launch cost",
    ],
    chains: POOLS_CHAINS,
  },
  "pools.launch_request_form": {
    embeddingText: embeddingText(
      `Open the app's launch form so the user can confirm making a new pools.fun coin on Robinhood Chain, the kind that opens straight into a real trading pool. ` +
      `Use when a coin should be made but the person, not the agent, approves the spending: the form arrives filled in with the proposed name, ticker, pairing and first buy, and they can change any of it and pick the picture. ` +
      `Submitting it is what approves the launch. ` +
      `Example queries: ask me to confirm the launch, open the launch form for a pools fun coin.`,
    ),
    aliases: ["pools fun launch form", "confirm a pools fun launch", "ask the user to approve a launch", "open the launch form"],
    exampleIntents: [
      "ask me to confirm this pools fun launch",
      "open the launch form so I can review the coin",
      "let me approve the coin before it is made",
    ],
    chains: POOLS_CHAINS,
  },
  "pools.launch_execute": {
    embeddingText: embeddingText(
      `Actually make a new pools.fun coin on Robinhood Chain, signing and paying for it from the user's own wallet. ` +
      `Use when the coin should be created now and the authority to spend it is already established: the launch charge is paid, an optional first buy happens in the same transaction, and the coin opens straight into a real trading pool rather than climbing a curve. ` +
      `Real money leaves the wallet and it cannot be undone. ` +
      `Vex checks the launchpad's own transaction against the chain first and refuses by name if anything disagrees. ` +
      `Example queries: launch the coin on pools fun now, create my pools fun token for real.`,
    ),
    aliases: [
      "launch a pools fun coin",
      "create a pools fun token for real",
      "deploy my coin on pools fun",
      "make the pools fun coin now",
    ],
    exampleIntents: [
      "launch my coin on pools fun now",
      "create the token on pools fun with a first buy",
      "deploy the pools fun coin for real",
    ],
    chains: POOLS_CHAINS,
  },
} satisfies Record<string, ToolDiscoveryMetadata>;

const EXPECTED_COUNT = 3;
if (Object.keys(POOLS_LAUNCH_DISCOVERY).length !== EXPECTED_COUNT) {
  throw new Error(
    `POOLS_LAUNCH_DISCOVERY has ${Object.keys(POOLS_LAUNCH_DISCOVERY).length} entries, expected ${EXPECTED_COUNT}.`,
  );
}
