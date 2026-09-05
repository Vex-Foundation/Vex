/**
 * Retrieval metadata for the fees-to-holders FAMILY: the read, the holder's
 * claim, and the permissionless distribute.
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
      + `Use when a coin is marked as paying its fees to holders, or when the user asks what holding it has earned them. `
      + `Nothing is staked here: the payout follows from holding the coin and builds up over a day. `
      + `Read from the contracts themselves, with the launchpad's own figures alongside. `
      + `A coin that shares nothing is reported so in words. Nothing is signed. `
      + `Example queries: what have I earned holding this coin, what does the distributor owe my wallet.`,
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
  "pools.holder_rewards_claim": {
    embeddingText: embeddingText(
      `Claim the fees a coin on pools.fun pays to the people who hold it, on Robinhood Chain. `
      + `Use when the user wants to collect what holding a coin has earned, or when a coin that shares its fees has a balance waiting. `
      + `Nothing is staked: the payout follows from holding the coin. `
      + `Ask what it would pay first with a dry run; without that it signs and spends gas. `
      + `Some coins pay the coin itself, some the asset it trades against, some both. `
      + `Vex takes no cut and the payout lands in the signing wallet. `
      + `Example queries: claim my holder rewards on this coin, cash out this coin's holder fees.`,
    ),
    aliases: [
      "claim holder rewards",
      "collect fees earned by holding",
      "cash out holder rewards on pools fun",
      "take my share of a coin's fees",
      "claim what I earned holding this token",
      "holder reward payout",
    ],
    exampleIntents: [
      "claim my holder rewards on this pools fun coin",
      "collect the fees I earned by holding this token",
      "take whatever this coin owes me as a holder",
      "cash out my share of this token's trading fees",
      "claim holder rewards for my wallet on this coin",
    ],
    chains: POOLS_CHAINS,
  },
  "pools.holder_rewards_distribute": {
    embeddingText: embeddingText(
      `Move a pools.fun coin's collected fees into the stream that pays its holders, on Robinhood Chain. `
      + `Anybody may do it and it does not pay whoever does: the money goes to everyone holding the coin, and the caller spends the gas. `
      + `Use when a coin's holder rewards have stalled, when fees have piled up unpaid, or when a holder wants what they are owed to start growing. `
      + `Some of these contracts hand the caller a small share of the buyback and some pay nothing at all. `
      + `Ask first with a dry run, which sends nothing. `
      + `Example queries: push this token's fees to its holders, trigger the reward distribution.`,
    ),
    aliases: [
      "distribute holder rewards",
      "push fees to holders",
      "trigger the reward distribution",
      "kick off a coin's holder payouts",
      "start the holder reward stream",
      "permissionless distribute on pools fun",
    ],
    exampleIntents: [
      "push this pools fun coin's fees to its holders",
      "trigger the holder reward distribution for this token",
      "start the reward stream on this coin so my earnings grow",
      "distribute the collected fees on this token",
      "kick the holder rewards on this coin",
    ],
    chains: POOLS_CHAINS,
  },
} satisfies Record<string, ToolDiscoveryMetadata>;

const EXPECTED_COUNT = 3;
if (Object.keys(POOLS_HOLDER_REWARDS_DISCOVERY).length !== EXPECTED_COUNT) {
  throw new Error(
    `POOLS_HOLDER_REWARDS_DISCOVERY has ${Object.keys(POOLS_HOLDER_REWARDS_DISCOVERY).length} entries, expected ${EXPECTED_COUNT}.`,
  );
}
