/**
 * Retrieval metadata for the indexify account reads (auth-gated). English-only.
 */

import type { ToolDiscoveryMetadata } from "../../types.js";
import { embeddingText } from "../../_embedding-text.js";
import { INDEXIFY_CHAINS } from "../../indexify/discovery-text.js";

export const INDEXIFY_ACCOUNT_DISCOVERY = {
  "indexify.portfolio": {
    embeddingText: embeddingText(
      `Read the linked Indexify account's balances: spendable USDC, USDC reserved by in-flight orders, total portfolio value in USDC, and the account's Indexify-embedded Solana wallet address, which doubles as the USDC deposit address. ` +
      `Use this when the user asks what the Indexify account holds, or before sizing a stack buy — the venue trades this custodial balance, never a Vex session wallet. ` +
      `Example queries: how much usdc is on the indexify account, indexify balance, what is the indexify deposit address.`,
    ),
    aliases: ["indexify balance", "indexify portfolio", "indexify usdc", "indexify wallet address"],
    exampleIntents: [
      "how much USDC does the indexify account hold",
      "what is the indexify account's total value",
      "where do I deposit USDC for indexify",
    ],
    chains: INDEXIFY_CHAINS,
  },
  "indexify.holdings": {
    embeddingText: embeddingText(
      `Read the linked Indexify account's position inside one stack: current value in USDC, total invested, cost basis, and realized plus unrealized profit and loss. ` +
      `Use this when the user asks how a stack investment is doing, or after a trade settles to confirm the position landed. A stack the account never bought answers with zeros rather than an error. ` +
      `Example queries: how is my stack position doing, my holdings in this stack, indexify position pnl.`,
    ),
    aliases: ["stack holdings", "my stack position", "stack pnl", "indexify holdings"],
    exampleIntents: [
      "how much of this stack does the account hold",
      "what is the pnl on this stack position",
      "did the stack purchase settle into a position",
    ],
    chains: INDEXIFY_CHAINS,
  },
  "indexify.orders": {
    embeddingText: embeddingText(
      `List the linked Indexify account's stack orders, or read one order in full by its id: lifecycle status, on-chain transaction hashes, and the partial-fill breakdown when some tokens failed to buy. ` +
      `Use this when a trade was just placed and its outcome must be confirmed — every Indexify trade becomes an order that settles asynchronously on the venue's side. ` +
      `Example queries: did my indexify order go through, order status, which tokens failed in the partial order.`,
    ),
    aliases: ["indexify orders", "order status", "partial order breakdown", "trade settlement"],
    exampleIntents: [
      "did the stack buy order succeed",
      "show the transaction hashes for this order",
      "which tokens failed in my partial order",
    ],
    chains: INDEXIFY_CHAINS,
  },
  "indexify.history": {
    embeddingText: embeddingText(
      `Read the linked Indexify account's transaction history: buys, sells, deposits and withdrawals with USDC amounts, creator and platform fees, lifecycle statuses and Solana transaction hashes, plus whole-account summary counts. ` +
      `Use this when the user asks what the account has traded or deposited, or wants past activity audited. Filter the rows by lifecycle status or by one stack. ` +
      `Example queries: indexify transaction history, what has this account traded, past stack purchases and fees paid.`,
    ),
    aliases: ["indexify history", "transaction history", "past trades", "account activity"],
    exampleIntents: [
      "show the indexify account's trade history",
      "list failed transactions on indexify",
      "how many buys has this account made",
    ],
    chains: INDEXIFY_CHAINS,
  },
} satisfies Record<string, ToolDiscoveryMetadata>;

const EXPECTED_COUNT = 4;
if (Object.keys(INDEXIFY_ACCOUNT_DISCOVERY).length !== EXPECTED_COUNT) {
  throw new Error(
    `INDEXIFY_ACCOUNT_DISCOVERY has ${Object.keys(INDEXIFY_ACCOUNT_DISCOVERY).length} entries, expected ${EXPECTED_COUNT}.`,
  );
}
