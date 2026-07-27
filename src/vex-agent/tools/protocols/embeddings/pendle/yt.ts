/**
 * Retrieval metadata for Pendle YT trade + income tools (quote + buy/sell/claim).
 * Manifest at `pendle/manifests/yt.ts` references entries by `toolId`.
 * Mutating passages open with an action verb (Buy / Sell / Claim) per lint.
 */

import type { ToolDiscoveryMetadata } from "../../types.js";
import { embeddingText } from "../../_embedding-text.js";
import { PENDLE_CHAINS } from "../../pendle/discovery-text.js";

export const PENDLE_YT_DISCOVERY = {
  "pendle.yt.quote": {
    embeddingText: embeddingText(
      `Preview a Pendle YT trade before executing — quote buying a yield token with a payment token or selling a YT back, with the output amount, price impact, aggregator, market liquidity, and the expiry horizon, on any of Pendle's 11 chains. ` +
      `Use when the user wants the price, rate, or route for variable yield exposure before committing funds, or to see how much a YT is worth as expiry nears. ` +
      `It also records the safety preview that the Pendle YT buy and sell tools require before they may broadcast. ` +
      `Example queries: quote a pendle YT buy, preview selling my YT, pendle variable yield price. Read-only.`,
    ),
    aliases: ["pendle YT quote", "yield token price", "preview pendle YT", "variable yield preview"],
    exampleIntents: ["quote a pendle YT buy", "preview selling my YT", "pendle YT price"],
    chains: PENDLE_CHAINS,
  },

  "pendle.yt.buy": {
    embeddingText: embeddingText(
      `Buy a Pendle yield token (YT) with a payment token to take leveraged, variable yield exposure on the underlying until the market's expiry, on any of Pendle's 11 chains. ` +
      `A YT decays toward zero as expiry approaches and is worth nothing after it — this is variable yield, not a fixed return. ` +
      `Use when the user wants to bet that realized yield beats the implied rate before maturity, after previewing with a Pendle YT quote. ` +
      `Requires a fresh matching pendle.yt.quote first; the trade is approval-gated and pins the canonical Pendle Router. ` +
      `Example queries: buy pendle YT, get variable yield exposure, long the yield on arbitrum, buy a yield token.`,
    ),
    aliases: ["pendle YT buy", "buy yield token", "long yield", "variable yield exposure"],
    exampleIntents: ["buy pendle YT", "get variable yield exposure", "long the yield"],
    chains: PENDLE_CHAINS,
  },

  "pendle.yt.sell": {
    embeddingText: embeddingText(
      `Sell a Pendle yield token (YT) back to a payment token before expiry — an early exit priced at the current market, which reflects the yield the market now expects, on any of Pendle's 11 chains. ` +
      `A YT decays toward zero as expiry nears, so exiting sooner preserves more of its remaining value. ` +
      `Use when the user wants to close variable yield exposure and realize its current worth ahead of maturity. ` +
      `Requires a fresh matching pendle.yt.quote first; the trade is approval-gated and pins the canonical Pendle Router. ` +
      `Example queries: sell my pendle YT, exit variable yield, close a yield token position, unwind a YT.`,
    ),
    aliases: ["pendle YT sell", "sell yield token", "exit variable yield", "unwind YT"],
    exampleIntents: ["sell my pendle YT", "exit variable yield", "close a YT position"],
    chains: PENDLE_CHAINS,
  },

  "pendle.claim": {
    embeddingText: embeddingText(
      `Claim the accrued interest and rewards from your Pendle positions on one chain in a single sweep — collects the yield earned by held yield tokens and the rewards from liquidity positions, sending everything to your wallet, on any of Pendle's 11 chains. ` +
      `Use when the user wants to harvest Pendle income without closing any position, either across every held market on a chain or scoped to one market address. ` +
      `Approval-gated and pins the canonical Pendle Router; it moves only accrued income, never principal. ` +
      `Example queries: claim my pendle rewards, harvest pendle yield on base, collect accrued interest from pendle.`,
    ),
    aliases: ["pendle claim", "claim pendle rewards", "harvest pendle yield", "collect pendle interest"],
    exampleIntents: ["claim my pendle rewards", "harvest pendle yield", "collect accrued interest"],
    chains: PENDLE_CHAINS,
  },
} satisfies Record<string, ToolDiscoveryMetadata>;

const EXPECTED_COUNT = 4;
if (Object.keys(PENDLE_YT_DISCOVERY).length !== EXPECTED_COUNT) {
  throw new Error(
    `PENDLE_YT_DISCOVERY has ${Object.keys(PENDLE_YT_DISCOVERY).length} entries, expected ${EXPECTED_COUNT}.`,
  );
}
