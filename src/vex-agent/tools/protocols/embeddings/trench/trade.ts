/**
 * Retrieval metadata for the Trench Express money-path tools (P2):
 * `trench.trade_quote` (read-only curve quote) and `trench.trade_execute`
 * (curve buy/sell). English-only passages; verb-first for the mutating execute.
 */

import type { ToolDiscoveryMetadata } from "../../types.js";
import { embeddingText } from "../../_embedding-text.js";
import { TRENCH_CHAINS } from "../../trench/discovery-text.js";

export const TRENCH_TRADE_DISCOVERY = {
  "trench.trade_quote": {
    embeddingText: embeddingText(
      `Preview the price of buying or selling a Trench Express bonding-curve token on Robinhood Chain before trading. ` +
      `Use when the user wants to know how many tokens a given amount of ETH would buy, or how much ETH selling a token would return, with Trench's own 1% curve fee, Vex's separate 25 bps fee, and the price impact against the curve reserves. ` +
      `The quote reads the curve on-chain and is exact and fee-inclusive; it signs nothing. ` +
      `Example queries: how much of this trench token can I buy with 0.01 ETH, what would selling my trench tokens return, price impact of a trench curve buy.`,
    ),
    aliases: ["trench trade quote", "curve buy quote", "curve sell quote", "trench price impact", "quote before buying trench token"],
    exampleIntents: ["how much of this trench token can I buy with 0.01 ETH", "what would selling my trench tokens return", "price impact of a trench curve buy"],
    chains: TRENCH_CHAINS,
  },
  "trench.trade_execute": {
    embeddingText: embeddingText(
      `Buy or sell a Trench Express bonding-curve token on Robinhood Chain, spending ETH to acquire the token or selling it back for ETH against the curve. ` +
      `Use when the user has decided to trade a launchpad token: a buy pays ETH for tokens, a sell approves then swaps tokens for ETH, both protected by a minimum-output floor from a fresh quote. ` +
      `Two fees hit the ETH leg: Trench's 1% curve fee and Vex's separate 25 bps (0.25%), taken after the trade confirms; it spends real funds and requires approval. ` +
      `Example queries: buy this trench token with 0.01 ETH, sell my trench launchpad tokens for ETH, execute a trench curve trade.`,
    ),
    aliases: ["buy trench token", "sell trench token", "execute trench trade", "trench curve buy", "trench curve sell"],
    exampleIntents: ["buy this trench token with 0.01 ETH", "sell my trench launchpad tokens for ETH", "execute a trench curve trade"],
    chains: TRENCH_CHAINS,
  },
} satisfies Record<string, ToolDiscoveryMetadata>;

const EXPECTED_COUNT = 2;
if (Object.keys(TRENCH_TRADE_DISCOVERY).length !== EXPECTED_COUNT) {
  throw new Error(
    `TRENCH_TRADE_DISCOVERY has ${Object.keys(TRENCH_TRADE_DISCOVERY).length} entries, expected ${EXPECTED_COUNT}.`,
  );
}
