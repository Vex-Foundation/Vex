/**
 * Retrieval metadata for Pendle LP tools (quote + single-token add/remove).
 * Manifest at `pendle/manifests/lp.ts` references entries by `toolId`.
 * Mutating passages open with an action verb (Add / Remove) per lint.
 */

import type { ToolDiscoveryMetadata } from "../../types.js";
import { embeddingText } from "../../_embedding-text.js";
import { PENDLE_CHAINS } from "../../pendle/discovery-text.js";

export const PENDLE_LP_DISCOVERY = {
  "pendle.lp.quote": {
    embeddingText: embeddingText(
      `Preview a Pendle single-token liquidity add or remove, on any of Pendle's 11 chains. ` +
      `An add deposits ONE token into a market's LP; a remove burns the LP token back to one token. ` +
      `Use when the user wants the output, price impact, aggregator, liquidity, or market expiry for providing or withdrawing single-token Pendle liquidity. ` +
      `After expiry LP still removes but stops earning fees and rewards. ` +
      `It records the safety preview add and remove require before broadcast. ` +
      `Example queries: quote adding pendle liquidity, preview removing pendle LP to a token, preview a single-token LP deposit. Read-only.`,
    ),
    aliases: ["pendle lp quote", "pendle liquidity quote", "preview add liquidity", "preview remove liquidity"],
    exampleIntents: ["quote adding pendle liquidity", "preview removing pendle LP to a token", "single-token LP deposit preview"],
    chains: PENDLE_CHAINS,
  },

  "pendle.lp.add": {
    embeddingText: embeddingText(
      `Add single-token liquidity to a Pendle market, depositing ONE token to receive the market's LP token, on any of Pendle's 11 chains. ` +
      `The LP earns swap fees and rewards until the market's expiry; it is NOT a fixed-rate lock and stops earning after expiry. ` +
      `Use when the user wants to provide liquidity to a Pendle pool with a single token rather than a token pair. ` +
      `Requires a fresh matching pendle.lp.quote first; approval-gated and pins the canonical Pendle Router. ` +
      `Example queries: add pendle liquidity, provide single-token LP to a pendle market, deposit one token into a pendle pool.`,
    ),
    aliases: ["pendle add liquidity", "add pendle lp", "provide pendle liquidity", "single-token lp add"],
    exampleIntents: ["add pendle liquidity", "provide single-token LP to a pendle market", "deposit into a pendle pool"],
    chains: PENDLE_CHAINS,
  },

  "pendle.lp.remove": {
    embeddingText: embeddingText(
      `Remove single-token liquidity from a Pendle market, burning the market's LP token to return ONE output token, on any of Pendle's 11 chains. ` +
      `Works before and after expiry: a matured market can still be removed on the principal side but no longer earns swap fees or rewards. ` +
      `Use when the user wants to withdraw from a Pendle pool into a single token. ` +
      `Requires a fresh matching pendle.lp.quote first; approval-gated and pins the canonical Pendle Router. ` +
      `Example queries: remove pendle liquidity, withdraw pendle LP to a token, exit a pendle pool to one token.`,
    ),
    aliases: ["pendle remove liquidity", "remove pendle lp", "withdraw pendle liquidity", "exit pendle pool"],
    exampleIntents: ["remove pendle liquidity", "withdraw pendle LP to a token", "exit a pendle pool to one token"],
    chains: PENDLE_CHAINS,
  },
} satisfies Record<string, ToolDiscoveryMetadata>;

const EXPECTED_COUNT = 3;
if (Object.keys(PENDLE_LP_DISCOVERY).length !== EXPECTED_COUNT) {
  throw new Error(
    `PENDLE_LP_DISCOVERY has ${Object.keys(PENDLE_LP_DISCOVERY).length} entries, expected ${EXPECTED_COUNT}.`,
  );
}
