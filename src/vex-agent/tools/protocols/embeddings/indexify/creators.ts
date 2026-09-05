/**
 * Retrieval metadata for the indexify creator reads. English-only passages.
 */

import type { ToolDiscoveryMetadata } from "../../types.js";
import { embeddingText } from "../../_embedding-text.js";
import { INDEXIFY_CHAINS } from "../../indexify/discovery-text.js";

export const INDEXIFY_CREATORS_DISCOVERY = {
  "indexify.creators": {
    embeddingText: embeddingText(
      `Read Indexify's creator leaderboard, or one creator's public profile and performance metrics. ` +
      `Use this when the user asks who the top stack creators are, or names a creator and wants their track record. ` +
      `The leaderboard ranks creators by points, combined profit and loss, stacks created, trades or hit rate over a chosen window; naming a username returns that creator's profile, hit rate, PnL, follower count and stack count instead. ` +
      `Example queries: top stack creators on indexify, who has the best hit rate, show this creator's track record.`,
    ),
    aliases: ["indexify leaderboard", "top creators", "creator track record", "best stack creators", "creator pnl"],
    exampleIntents: [
      "who are the top creators on indexify",
      "show me the creator leaderboard by pnl",
      "what is this creator's hit rate",
    ],
    chains: INDEXIFY_CHAINS,
  },
} satisfies Record<string, ToolDiscoveryMetadata>;

const EXPECTED_COUNT = 1;
if (Object.keys(INDEXIFY_CREATORS_DISCOVERY).length !== EXPECTED_COUNT) {
  throw new Error(
    `INDEXIFY_CREATORS_DISCOVERY has ${Object.keys(INDEXIFY_CREATORS_DISCOVERY).length} entries, expected ${EXPECTED_COUNT}.`,
  );
}
