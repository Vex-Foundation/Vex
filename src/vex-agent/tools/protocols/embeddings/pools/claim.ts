/**
 * Retrieval metadata for the pools.fun creator-fee claim.
 *
 * The passage leads with the DISTINCTIVE fact - fees a coin you launched has
 * earned, waiting in the launchpad's locker - because "claim" alone collides
 * with prediction-market claims and yield claims, which are the nearest
 * neighbours in this space.
 */

import type { ToolDiscoveryMetadata } from "../../types.js";
import { embeddingText } from "../../_embedding-text.js";
import { POOLS_CHAINS } from "../../pools/discovery-text.js";

export const POOLS_CLAIM_DISCOVERY = {
  "pools.claim_fees": {
    embeddingText: embeddingText(
      `Send a transaction that collects the trading fees a coin launched on pools.fun has earned for its creator, on Robinhood Chain. ` +
      `Use when: the user wants what their coin has earned, either paid out or just quoted. ` +
      `Every pool charges one percent per trade and the launcher's share builds up in the locker until claimed. ` +
      `A dry run simulates the claim from the user's own wallet and says what would arrive; without one it signs and spends gas. ` +
      `A claim pays two assets at once, the launched coin and whatever the pool trades against, reported separately. ` +
      `Example queries: claim my creator fees, how much has my coin earned me.`,
    ),
    aliases: [
      "claim creator fees",
      "collect fees from my coin",
      "pools fun creator earnings",
      "how much has my token earned",
    ],
    exampleIntents: [
      "claim the creator fees on my pools fun coin",
      "how much would I get if I claimed my fees",
      "collect what my token has earned",
    ],
    chains: POOLS_CHAINS,
  },
} satisfies Record<string, ToolDiscoveryMetadata>;
