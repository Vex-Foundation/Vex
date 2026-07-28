/**
 * Retrieval metadata for the Pendle SY wrap / unwrap tools (R5d card D3).
 * Manifest at `pendle/manifests/sy.ts` references entries by `toolId`.
 *
 * Both passages open with an action verb (Wrap / Unwrap) per the mutating-tool
 * lint rule, and both state the boundaries a context-free agent would otherwise
 * have to guess: exact-input only (you choose what goes in, never what comes
 * out), ERC-20 only, and proceeds to your own wallet. `pendle.sy.redeem` names
 * its single most valuable use out loud — finishing a `pendle.pt.redeem` that
 * fell back to paying SY — because that is the situation an agent lands in
 * without having asked for SY at all.
 */

import type { ToolDiscoveryMetadata } from "../../types.js";
import { embeddingText } from "../../_embedding-text.js";
import { PENDLE_CHAINS } from "../../pendle/discovery-text.js";

export const PENDLE_SY_DISCOVERY = {
  "pendle.sy.mint": {
    embeddingText: embeddingText(
      `Wrap a plain token into Pendle SY, the standardised yield form of a yield-bearing asset that principal and yield tokens are minted from, on any of Pendle's 11 chains. ` +
      `Use when the user wants to hold SY itself rather than buy a PT or mint a PT and YT pair. ` +
      `You choose the amount going in and receive an estimate out, never a guaranteed output. ` +
      `Takes an ERC-20 token only; the SY lands in your own wallet. ` +
      `Quote it first with a dry run, then repeat the call to broadcast. ` +
      `Example queries: wrap a token into pendle SY, get SY for my staked ETH, convert a token to standardised yield.`,
    ),
    aliases: ["pendle sy mint", "wrap into sy", "mint pendle sy", "standardised yield wrap"],
    exampleIntents: ["wrap a token into pendle SY", "get SY for my staked ETH", "convert a token to standardised yield"],
    chains: PENDLE_CHAINS,
  },

  "pendle.sy.redeem": {
    embeddingText: embeddingText(
      `Unwrap Pendle SY back into a plain token, on any of Pendle's 11 chains. ` +
      `Use when a matured principal-token redeem fell back to paying SY instead of the market's underlying asset and those proceeds still need turning into a normal token, or when the user simply holds SY and wants out. ` +
      `You choose the SY amount going in and receive an estimate out, never a guaranteed output amount. ` +
      `Delivers an ERC-20 token to your own wallet. ` +
      `Quote it first with a dry run, then repeat the same call to broadcast. ` +
      `Example queries: unwrap my pendle SY, turn SY back into a token, finish a pendle redeem that paid SY.`,
    ),
    aliases: ["pendle sy redeem", "unwrap sy", "redeem pendle sy", "sy back to token"],
    exampleIntents: ["unwrap my pendle SY", "turn SY back into a token", "finish a pendle redeem that paid SY"],
    chains: PENDLE_CHAINS,
  },
} satisfies Record<string, ToolDiscoveryMetadata>;

const EXPECTED_COUNT = 2;
if (Object.keys(PENDLE_SY_DISCOVERY).length !== EXPECTED_COUNT) {
  throw new Error(
    `PENDLE_SY_DISCOVERY has ${Object.keys(PENDLE_SY_DISCOVERY).length} entries, expected ${EXPECTED_COUNT}.`,
  );
}
