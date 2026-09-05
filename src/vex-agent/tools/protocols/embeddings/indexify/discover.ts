/**
 * Retrieval metadata for the indexify discovery reads. English-only passages.
 */

import type { ToolDiscoveryMetadata } from "../../types.js";
import { embeddingText } from "../../_embedding-text.js";
import { INDEXIFY_CHAINS } from "../../indexify/discovery-text.js";

export const INDEXIFY_DISCOVER_DISCOVERY = {
  "indexify.stacks": {
    embeddingText: embeddingText(
      `Browse the stacks on Indexify, the social index platform on Solana where creators bundle tokens into investable baskets. ` +
      `Use this when the user wants trending stacks, official Indexify stacks, or the catalogue ranked by price change, market cap or age, with market cap filters. ` +
      `Each row carries the stack's id, slug, price, performance over several windows, creator and token count. ` +
      `Example queries: trending stacks on indexify, best performing index this week, official indexify stacks, newest crypto index baskets.`,
    ),
    aliases: ["indexify stacks", "browse stacks", "trending stacks", "index baskets on solana", "crypto index funds"],
    exampleIntents: [
      "what stacks are trending on indexify",
      "show me the best performing stacks this month",
      "list the official indexify stacks",
    ],
    chains: INDEXIFY_CHAINS,
  },
  "indexify.search": {
    embeddingText: embeddingText(
      `Find a stack on Indexify by its name. Use this when the user names a stack and you need its id or slug before reading its detail, its holdings, or trading it. ` +
      `Returns matching stack names with their ids, slugs and truncated descriptions. Stack names are not unique on this venue, so several rows can match one name and the id is the identity to act on. ` +
      `Example queries: find the stack called solana top 5 defi, look up an indexify stack by name, which stack is named doge basket.`,
    ),
    aliases: ["find indexify stack", "stack by name", "indexify stack lookup", "search stacks"],
    exampleIntents: [
      "find the indexify stack called solana defi index",
      "look up a stack by its name",
      "is there a stack named ai agents",
    ],
    chains: INDEXIFY_CHAINS,
  },
  "indexify.stack": {
    embeddingText: embeddingText(
      `Read one Indexify stack in full: its token allocations with percentage weights, price, performance windows, market cap, total value locked, investor count, creator, category and the shareable web link. ` +
      `Use this when a browse or search has resolved the stack's slug or id and the user wants what is inside it, or before quoting fees or trading it. ` +
      `Example queries: what is inside this stack, stack allocation weights, who created this stack, indexify stack detail, link for this stack.`,
    ),
    aliases: ["stack detail", "stack composition", "what is in this stack", "stack allocations", "stack link"],
    exampleIntents: [
      "what tokens are inside the solana defi stack",
      "show the allocation weights of this stack",
      "get the link for this indexify stack",
    ],
    chains: INDEXIFY_CHAINS,
  },
  "indexify.tokens": {
    embeddingText: embeddingText(
      `Search Indexify's own catalogue of tradable Solana tokens by name or symbol. ` +
      `Use this when a new stack's allocations need exact mint addresses, or when the user asks whether Indexify can trade a token at all. ` +
      `Returns token names, symbols, mint addresses and verification flags. A token absent from this catalogue cannot go into a stack on the venue. ` +
      `Example queries: can indexify trade this token, find the mint address for a stack allocation, indexify token catalogue.`,
    ),
    aliases: ["indexify tokens", "tradable tokens", "token catalogue", "token mint for stack"],
    exampleIntents: [
      "which tokens can go into an indexify stack",
      "find jupiter's mint address in the indexify catalogue",
      "is this token tradable on indexify",
    ],
    chains: INDEXIFY_CHAINS,
  },
} satisfies Record<string, ToolDiscoveryMetadata>;

const EXPECTED_COUNT = 4;
if (Object.keys(INDEXIFY_DISCOVER_DISCOVERY).length !== EXPECTED_COUNT) {
  throw new Error(
    `INDEXIFY_DISCOVER_DISCOVERY has ${Object.keys(INDEXIFY_DISCOVER_DISCOVERY).length} entries, expected ${EXPECTED_COUNT}.`,
  );
}
