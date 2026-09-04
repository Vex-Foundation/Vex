/**
 * Retrieval metadata for the fees-to-holders read.
 *
 * The passage leads with EARNED BY HOLDING, because the nearest neighbours are
 * the creator-fee claim (earned by LAUNCHING) and staking rewards (earned by
 * LOCKING), and this one is neither: nothing is staked, and the payout follows
 * from simply holding the coin.
 */

import type { ToolDiscoveryMetadata } from "../../types.js";
import { embeddingText } from "../../_embedding-text.js";
import { POOLS_CHAINS } from "../../pools/discovery-text.js";

export const POOLS_HOLDER_REWARDS_DISCOVERY = {
  "pools.holder_rewards": {
    embeddingText: embeddingText(
      `Read the fees to holders state of a coin on pools.fun, on Robinhood Chain: which contract distributes those fees and what it owes one wallet. `
      + `Use when a coin is marked as paying its fees to holders, when the user asks what holding it has earned them, or when the distributor and the reward mode of such a coin have to be confirmed. `
      + `Nothing is staked here: the payout follows from holding the coin, and it builds up over a day at a time. `
      + `The answer is read from the contracts themselves and says which contract pays, which assets it pays in, and how much this wallet could take right now, with the launchpad's own figures shown alongside. `
      + `A coin that does not share its fees is reported as such in words, because that choice is fixed when the coin is created and cannot be turned on later. `
      + `Nothing is sent and nothing is signed. `
      + `Example queries: what have I earned holding this coin, does this coin pay its holders, how much is waiting for me on this token.`,
    ),
    aliases: [
      "fees to holders",
      "fees to holders state",
      "holder rewards on pools fun",
      "reward distributor for a coin",
      "what have I earned holding this coin",
      "what the distributor owes my wallet",
      "does this coin pay holders",
    ],
    exampleIntents: [
      "read the fees to holders state of this pools fun coin",
      "what have I earned by holding this pools fun coin",
      "what does the distributor owe my wallet on this token",
      "does this token share its fees with holders",
      "how much can I take from this coin's holder rewards",
    ],
    chains: POOLS_CHAINS,
  },
} satisfies Record<string, ToolDiscoveryMetadata>;

const EXPECTED_COUNT = 1;
if (Object.keys(POOLS_HOLDER_REWARDS_DISCOVERY).length !== EXPECTED_COUNT) {
  throw new Error(
    `POOLS_HOLDER_REWARDS_DISCOVERY has ${Object.keys(POOLS_HOLDER_REWARDS_DISCOVERY).length} entries, expected ${EXPECTED_COUNT}.`,
  );
}
