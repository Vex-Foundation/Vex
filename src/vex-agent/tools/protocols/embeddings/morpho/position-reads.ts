/**
 * Retrieval metadata for the Morpho POSITION and ACTIVITY reads.
 *
 * Manifests at `morpho/manifests/{positions-get,markets-activity}.ts` reference
 * these entries by `toolId`.
 *
 * THE NAMESPACE'S VOCABULARY IS NOW SPLIT THREE WAYS, and this file carries the
 * third constraint. The market and vault lanes already had to be pulled apart
 * because "supply", "deposit" and "earn" describe both of them; these two tools
 * add a third intent that would otherwise collide with both.
 *
 *   MARKET intent    - screening a venue to enter: where to lend, cheapest
 *                      borrow, utilization, liquidation threshold.
 *   VAULT intent     - handing money to a manager: curated vault, passive park,
 *                      curator, share price.
 *   PORTFOLIO intent - what the user ALREADY has, and what already happened:
 *                      my positions, my deposits, what I owe, health factor,
 *                      am I about to be liquidated, transaction history, recent
 *                      liquidations, who liquidated me.
 *
 * The separator is POSSESSION AND PAST TENSE. Nothing below uses a screening
 * verb ("find", "best", "compare", "where to") or a shopping phrase from either
 * of the other two lanes; every passage here is about an existing holding or a
 * recorded event. `market-reads.ts` and `vault-reads.ts` carry the reciprocal
 * constraints and say so.
 *
 * Neither passage enumerates chain slugs: that list has one home in the
 * structured `chains` field, where it recalls at a deliberately low weight, and
 * duplicating it into prose measurably distorted an unrelated eval query during
 * batch 1.
 */

import type { ToolDiscoveryMetadata } from "../../types.js";
import { embeddingText } from "../../_embedding-text.js";
import { MORPHO_CHAINS_FOR_DISCOVERY } from "../../morpho/discovery-text.js";

export const MORPHO_POSITION_READ_DISCOVERY = {
  "morpho.positions.get": {
    embeddingText: embeddingText(
      `Read what one wallet already holds on Morpho: what it lent, what it put up as collateral, what it owes, ` +
      `and how close each borrowing position is to being taken. ` +
      `Use when the user asks about their own lending money, what they owe, whether they are about to be ` +
      `liquidated, or how safe their loan is. ` +
      `Returns each open position with its health factor and how far the price can fall first, the deposits held ` +
      `with managers, profit so far, and the portfolio value in dollars. One wallet at a time. ` +
      `Example queries: my morpho positions, am I close to liquidation, what do I owe.`,
    ),
    aliases: [
      "my morpho positions",
      "health factor",
      "am I going to be liquidated",
      "what do I owe",
      "my collateral",
      "my lending deposits",
      "loan safety",
      "liquidation risk",
    ],
    exampleIntents: [
      "show my morpho positions",
      "am I close to liquidation",
      "what is my health factor",
      "my lending deposits and loans",
      "how much do I owe on morpho",
      "how far can the price fall before I get liquidated",
    ],
    chains: MORPHO_CHAINS_FOR_DISCOVERY,
  },

  "morpho.markets.activity": {
    embeddingText: embeddingText(
      `Read the transaction record of Morpho lending markets: who moved money in or out, when, and every ` +
      `liquidation with what was repaid, what was seized, and whether debt was left behind. ` +
      `Use when the user asks what has been happening in a market, whether anyone still uses it, how often people ` +
      `get liquidated there, or wants one address audited. ` +
      `Returns each event with its transaction hash, block, time, actor and amounts, filterable by market, by ` +
      `address, by kind of event and by time window. A record of the past, not advice. ` +
      `Example queries: recent liquidations, transaction history for this market, who liquidated me.`,
    ),
    aliases: [
      "morpho transaction history",
      "recent liquidations",
      "liquidation history",
      "market activity",
      "who liquidated me",
      "bad debt events",
      "market transaction log",
      "address history on morpho",
    ],
    exampleIntents: [
      "recent liquidations on this market",
      "market transaction history",
      "who liquidated me",
      "has anyone been liquidated here lately",
      "what has this wallet done on morpho",
      "is this lending market still being used",
    ],
    chains: MORPHO_CHAINS_FOR_DISCOVERY,
  },
} satisfies Record<string, ToolDiscoveryMetadata>;

const EXPECTED_COUNT = 2;
if (Object.keys(MORPHO_POSITION_READ_DISCOVERY).length !== EXPECTED_COUNT) {
  throw new Error(
    `MORPHO_POSITION_READ_DISCOVERY has ${Object.keys(MORPHO_POSITION_READ_DISCOVERY).length} entries, expected ${EXPECTED_COUNT}.`,
  );
}
