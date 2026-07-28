/**
 * Retrieval metadata for the Pendle TERM-MOBILITY tools (R5d card E4).
 * Manifest at `pendle/manifests/reflect.ts` references entries by `toolId`.
 *
 * All three passages open with an action verb (Roll / Move / Convert) per the
 * mutating-tool lint rule, and each states the ONE boundary a context-free
 * agent would otherwise guess wrong:
 *
 *   - `pendle.pt.rollover` is the MOVE-MY-TERM primitive. A user who says
 *     "extend my fixed rate" or "my PT is about to expire" means this, not a
 *     sell followed by a buy — so the passage carries that intent vocabulary
 *     rather than trade vocabulary.
 *   - `pendle.lp.transfer` moves ONE instrument to ONE instrument. It does NOT
 *     keep the yield token; the live captures showed a single output leg, and
 *     a passage that hinted otherwise would advertise a variant that is not
 *     served.
 *   - `pendle.lp.toPt` is SAME-MARKET only. There is no underlying to choose,
 *     so the passage says so out loud instead of leaving a retrieval hit that
 *     an agent would try to point at another market's principal token.
 *
 * Each also states the maturity asymmetry in plain words — you may leave an
 * expired position, you may not enter one — because it is the refusal these
 * tools issue most often.
 */

import type { ToolDiscoveryMetadata } from "../../types.js";
import { embeddingText } from "../../_embedding-text.js";
import { PENDLE_CHAINS } from "../../pendle/discovery-text.js";

export const PENDLE_REFLECT_DISCOVERY = {
  "pendle.pt.rollover": {
    embeddingText: embeddingText(
      `Roll a Pendle principal token into a later-expiry one of another market in a single transaction, across Pendle's 11 chains. ` +
      `Use when a fixed-rate position is maturing and the user wants to extend the term or move to a better rate, never holding the underlying in between. ` +
      `The position you leave may already have expired; the one you enter must still be active. ` +
      `Reports the rate before and after. ` +
      `Quote it first with a dry run, then repeat the same call to broadcast. ` +
      `Example queries: roll my pendle PT into a later expiry, extend my fixed rate, move to a longer maturity.`,
    ),
    aliases: ["pendle pt rollover", "roll pendle position", "extend fixed rate", "move pendle maturity", "reinvest maturing PT"],
    exampleIntents: [
      "roll my pendle PT into a later expiry",
      "extend my fixed rate",
      "move to a longer pendle maturity",
    ],
    chains: PENDLE_CHAINS,
  },

  "pendle.lp.transfer": {
    embeddingText: embeddingText(
      `Move Pendle liquidity out of one market's pool and into another market's pool in a single transaction, across Pendle's 11 chains. ` +
      `Use when the user wants to relocate a liquidity position to a different maturity or a better-earning pool, with no manual withdraw-then-deposit and no funds passing through the wallet. ` +
      `One position goes in and one comes out; the yield token is not kept. ` +
      `The pool you leave may already have expired; the one you enter must still be active. ` +
      `Quote it first with a dry run, then repeat the call to broadcast. ` +
      `Example queries: move my pendle liquidity to another market, switch pendle pools.`,
    ),
    aliases: ["pendle lp transfer", "migrate pendle liquidity", "move pendle lp", "switch pendle pool", "relocate liquidity"],
    exampleIntents: [
      "move my pendle liquidity to another market",
      "migrate pendle LP to a new maturity",
      "switch pendle pools",
    ],
    chains: PENDLE_CHAINS,
  },

  "pendle.lp.toPt": {
    embeddingText: embeddingText(
      `Convert a Pendle liquidity position into the same market's principal token in a single transaction, across Pendle's 11 chains. ` +
      `Use when the user wants to trade variable pool exposure for that market's fixed rate without first withdrawing to an ordinary token. ` +
      `Same market only: the principal token you receive is that market's own, so there is no underlying to choose. ` +
      `The market must still be active; a matured pool is withdrawn instead. ` +
      `Quote it first with a dry run, then repeat the same call to broadcast. ` +
      `Example queries: turn my pendle LP into PT, convert liquidity to fixed yield.`,
    ),
    aliases: ["pendle lp to pt", "convert lp to principal token", "liquidity to fixed yield", "lp into pt"],
    exampleIntents: [
      "turn my pendle LP into PT",
      "convert liquidity to fixed yield",
      "swap my pendle pool position for principal",
    ],
    chains: PENDLE_CHAINS,
  },
} satisfies Record<string, ToolDiscoveryMetadata>;

const EXPECTED_COUNT = 3;
if (Object.keys(PENDLE_REFLECT_DISCOVERY).length !== EXPECTED_COUNT) {
  throw new Error(
    `PENDLE_REFLECT_DISCOVERY has ${Object.keys(PENDLE_REFLECT_DISCOVERY).length} entries, expected ${EXPECTED_COUNT}.`,
  );
}
