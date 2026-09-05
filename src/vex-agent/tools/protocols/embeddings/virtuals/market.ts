/**
 * Retrieval metadata for the Virtuals market-history tools.
 *
 * Source-of-truth for the lexical scorer and the dense-retrieval pipeline.
 * Manifest at `virtuals/manifests/market.ts` references entries by `toolId`.
 * Vectors are (re)built by the boot reconcile / `tool-reembed`; passages live
 * in code. Both tools are read-only (no mutating action verb required).
 */

import type { ToolDiscoveryMetadata } from "../../types.js";
import { embeddingText } from "../../_embedding-text.js";
import { VIRTUALS_CHAIN_LABELS } from "../../virtuals/discovery-text.js";

export const VIRTUALS_MARKET_DISCOVERY = {
  "virtuals.trades": {
    embeddingText: embeddingText(
      `Read the live trade tape for one Virtuals agent token on its bonding curve - every recent buy and sell with the wallet, the transaction hash, the amounts, the price and the time. `
      + `Use this when the user wants to see who is trading a pre-graduation agent, how much is being bought or sold, or whether a fresh launch has real flow behind it. Filter to buys or sells. `
      + `Example queries: recent trades for this virtuals agent, who is buying this agent token, show the trade tape for the bonding curve, is anyone actually trading this agent.`,
    ),
    aliases: ["agent trade tape", "virtuals trades", "bonding curve trades", "recent agent buys", "who is trading this agent"],
    exampleIntents: ["recent trades for this virtuals agent", "show buys only for this agent token", "is anyone trading this bonding curve"],
    chains: VIRTUALS_CHAIN_LABELS,
  },

  "virtuals.candles": {
    embeddingText: embeddingText(
      `Get the OHLCV price history - open, high, low, close and volume per bucket - for one Virtuals agent token's pool, at minute, hour or day resolution, walking as far back as the pool has history. `
      + `Use this when the user wants a price chart, a trend, a high and low over a period, or the history behind a move on a graduated Virtuals agent. `
      + `Example queries: price chart for this virtuals agent, hourly candles for the agent token, what was the high and low today, price history since graduation, ohlcv candles for this agent pool.`,
    ),
    aliases: ["agent price chart", "virtuals candles", "ohlcv candles for agent token", "agent price history", "hourly candles"],
    exampleIntents: ["price chart for this virtuals agent", "hourly candles for this agent token", "price history since it graduated"],
    chains: VIRTUALS_CHAIN_LABELS,
  },
} satisfies Record<string, ToolDiscoveryMetadata>;

const EXPECTED_COUNT = 2;
if (Object.keys(VIRTUALS_MARKET_DISCOVERY).length !== EXPECTED_COUNT) {
  throw new Error(
    `VIRTUALS_MARKET_DISCOVERY has ${Object.keys(VIRTUALS_MARKET_DISCOVERY).length} entries, expected ${EXPECTED_COUNT}.`,
  );
}
