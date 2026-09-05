/**
 * Retrieval metadata for the indexify fee read and the two trading mutations.
 * English-only passages.
 */

import type { ToolDiscoveryMetadata } from "../../types.js";
import { embeddingText } from "../../_embedding-text.js";
import { INDEXIFY_CHAINS } from "../../indexify/discovery-text.js";

export const INDEXIFY_TRADE_DISCOVERY = {
  "indexify.fees": {
    embeddingText: embeddingText(
      `Preview Indexify's trading costs: the platform's minimum buy, the creator fee bounds, and the estimated fee for a stated USDC amount on a specific stack. ` +
      `Use this when a stack trade is being sized and its real cost must be stated first — the venue charges one percent per trade plus a creator fee of up to half a percent, with gas sponsored. ` +
      `Example queries: what would a 100 dollar stack buy cost in fees, indexify minimum buy, creator fee bounds.`,
    ),
    aliases: ["indexify fees", "stack trade cost", "minimum buy", "creator fee"],
    exampleIntents: [
      "what fees would a 50 dollar stack purchase pay",
      "what is the minimum indexify buy",
      "how much of a trade goes to the creator",
    ],
    chains: INDEXIFY_CHAINS,
  },
  "indexify.trade_execute": {
    embeddingText: embeddingText(
      `Buy or sell an Indexify stack for real. Use this when the user explicitly wants to invest the linked account's USDC into a stack or convert part of a held position back to USDC. ` +
      `A buy spends a stated USDC amount split across the stack's tokens; a sell converts a stated percent of the held position. The trade executes server side on Indexify the moment it is submitted and settles asynchronously as an order. ` +
      `Example queries: buy a stack with usdc, buy 20 dollars of this stack, sell half my stack position, invest in this index basket now.`,
    ),
    aliases: ["buy a stack", "sell a stack", "invest in a stack", "stack trade", "indexify swap"],
    exampleIntents: [
      "buy 10 USDC of the trending stack",
      "sell 50 percent of my position in this stack",
      "invest in this index basket",
    ],
    chains: INDEXIFY_CHAINS,
  },
  "indexify.order_resolve": {
    embeddingText: embeddingText(
      `Resolve a partially filled Indexify order: retry the tokens that failed to buy, acknowledge the partial fill as final, or sell everything the order did manage to buy. ` +
      `Use this when an order read shows status partial and the user has chosen how to finish it — partial fills happen on low-liquidity tokens and the order stays open until one of these resolutions is applied. ` +
      `Example queries: retry the failed tokens in my order, accept the partial fill, unwind the partial stack purchase.`,
    ),
    aliases: ["resolve partial order", "retry order", "acknowledge partial", "sell all partial"],
    exampleIntents: [
      "retry the failed part of my stack order",
      "accept my partial order as it is",
      "sell what the partial order bought",
    ],
    chains: INDEXIFY_CHAINS,
  },
} satisfies Record<string, ToolDiscoveryMetadata>;

const EXPECTED_COUNT = 3;
if (Object.keys(INDEXIFY_TRADE_DISCOVERY).length !== EXPECTED_COUNT) {
  throw new Error(
    `INDEXIFY_TRADE_DISCOVERY has ${Object.keys(INDEXIFY_TRADE_DISCOVERY).length} entries, expected ${EXPECTED_COUNT}.`,
  );
}
