/**
 * Retrieval metadata for the indexify stack-creation mutation. English-only.
 */

import type { ToolDiscoveryMetadata } from "../../types.js";
import { embeddingText } from "../../_embedding-text.js";
import { INDEXIFY_CHAINS } from "../../indexify/discovery-text.js";

export const INDEXIFY_CREATE_DISCOVERY = {
  "indexify.stack_create": {
    embeddingText: embeddingText(
      `Create a new stack on Indexify under the linked account: name it, describe the thesis, pick a risk category, and allocate up to twelve Solana tokens by integer percentage weights that sum to one hundred. ` +
      `Use this when the user explicitly wants to publish an index basket of their own. Creation moves no funds, and the new stack is public immediately at its own web link, ready for anyone to invest in. ` +
      `Example queries: create an index basket of solana defi tokens, make a stack on indexify, publish a curated token portfolio.`,
    ),
    aliases: ["create a stack", "make an index", "publish a stack", "new token basket", "curate a portfolio"],
    exampleIntents: [
      "create a stack with jupiter and jito at 50 percent each",
      "publish an ai tokens index on indexify",
      "make a new stack for my community",
    ],
    chains: INDEXIFY_CHAINS,
  },
} satisfies Record<string, ToolDiscoveryMetadata>;

const EXPECTED_COUNT = 1;
if (Object.keys(INDEXIFY_CREATE_DISCOVERY).length !== EXPECTED_COUNT) {
  throw new Error(
    `INDEXIFY_CREATE_DISCOVERY has ${Object.keys(INDEXIFY_CREATE_DISCOVERY).length} entries, expected ${EXPECTED_COUNT}.`,
  );
}
