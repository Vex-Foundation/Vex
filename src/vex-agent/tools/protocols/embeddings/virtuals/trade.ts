/**
 * Retrieval metadata for the Virtuals bonding-curve trade tools.
 *
 * Source of truth for the lexical scorer and the dense-retrieval pipeline.
 * Manifest at `virtuals/manifests/trade.ts` references entries by `toolId`.
 *
 * The two passages deliberately separate PRICING from SIGNING: an agent that
 * asks "how much would I get" must reach the quote, and one that asks "buy it"
 * must reach the execute, and a shared passage would make both ambiguous.
 */

import type { ToolDiscoveryMetadata } from "../../types.js";
import { embeddingText } from "../../_embedding-text.js";
import { VIRTUALS_CHAIN_LABELS } from "../../virtuals/discovery-text.js";

export const VIRTUALS_TRADE_DISCOVERY = {
  "virtuals.trade.quote": {
    embeddingText: embeddingText(
      `Price a buy or a sell of a Virtuals agent token on its bonding curve before committing: how much VIRTUAL it costs, how many agent tokens arrive, the curve's own tax, the anti-sniper window and its tax right now, and the floor the contract will enforce. `
      + `Use this when the user wants to know what a Virtuals agent would cost to buy or what a holding would fetch, or before executing a curve trade. Read-only, nothing is signed. `
      + `Example queries: what would 1 VIRTUAL buy of this agent, quote a sell of my agent tokens, price a virtuals bonding curve trade, is the anti-sniper tax still active on this launch.`,
    ),
    aliases: [
      "quote virtuals agent",
      "price a bonding curve trade",
      "virtuals curve quote",
      "how much to buy this agent token",
      "anti-sniper tax right now",
    ],
    exampleIntents: [
      "what would half a VIRTUAL buy of this agent",
      "quote selling my agent tokens back to the curve",
      "price a virtuals curve buy before I commit",
    ],
    chains: VIRTUALS_CHAIN_LABELS,
  },

  "virtuals.trade.execute": {
    embeddingText: embeddingText(
      `Buy or sell a Virtuals agent token on its bonding curve for real, against a quote already taken: approves the exact amount to the curve router when needed, sends the trade with the floor the quote sealed, and takes Vex's fee only after the trade confirms. `
      + `Use this when the user wants to buy into a Virtuals agent that has not graduated, or sell agent tokens back to the curve. Real funds; a graduated agent must be traded on its AMM pool instead. `
      + `Example queries: buy this virtuals agent, sell my agent tokens on the curve, execute the virtuals curve trade I just quoted, ape into this virtuals launch.`,
    ),
    aliases: [
      "buy virtuals agent token",
      "sell agent token on the curve",
      "execute virtuals curve trade",
      "trade a virtuals bonding curve",
      "ape into a virtuals launch",
    ],
    exampleIntents: [
      "buy this virtuals agent with one VIRTUAL",
      "sell my agent tokens back to the bonding curve",
      "execute the curve trade from that quote",
    ],
    chains: VIRTUALS_CHAIN_LABELS,
  },
} satisfies Record<string, ToolDiscoveryMetadata>;

const EXPECTED_COUNT = 2;
if (Object.keys(VIRTUALS_TRADE_DISCOVERY).length !== EXPECTED_COUNT) {
  throw new Error(
    `VIRTUALS_TRADE_DISCOVERY has ${Object.keys(VIRTUALS_TRADE_DISCOVERY).length} entries, expected ${EXPECTED_COUNT}.`,
  );
}
