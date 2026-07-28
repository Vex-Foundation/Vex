/**
 * Retrieval metadata for the Pendle DUAL-LP tools (R5d card E3).
 * Manifest at `pendle/manifests/lp-dual.ts` references entries by `toolId`.
 *
 * Both passages open with an action verb (Remove / Add) per the mutating-tool
 * lint rule, and both state the boundary a context-free agent would otherwise
 * guess at: these produce TWO instruments, not one, and the second one is the
 * market's own PT or YT rather than anything the caller chooses.
 *
 * NEITHER passage claims a dual ADD exists. Pendle has no
 * "add-liquidity-dual" action reachable through Convert: the keep-YT add is
 * still a SINGLE-token deposit, it simply keeps the YT that would otherwise be
 * sold into the pool. Wording that blurred the two would send an agent looking
 * for a tool that cannot be built.
 */

import type { ToolDiscoveryMetadata } from "../../types.js";
import { embeddingText } from "../../_embedding-text.js";
import { PENDLE_CHAINS } from "../../pendle/discovery-text.js";

export const PENDLE_LP_DUAL_DISCOVERY = {
  "pendle.lp.removeDual": {
    embeddingText: embeddingText(
      `Remove Pendle liquidity into BOTH a plain token and the market's principal token at once, across Pendle's 11 chains. ` +
      `Use when the user wants to keep principal exposure while taking part of a liquidity position back as an ordinary token, rather than exiting entirely to one token. ` +
      `Two outputs land in your own wallet, each protected by its own minimum. ` +
      `Estimates out, never a guaranteed amount. ` +
      `Works after the market expires as well as before. ` +
      `Quote it first with a dry run, then repeat the same call to broadcast. ` +
      `Example queries: remove pendle liquidity into a token and PT, exit pendle LP but keep the principal token.`,
    ),
    aliases: ["pendle remove liquidity dual", "remove pendle lp to token and pt", "dual lp exit", "pendle lp withdraw both legs"],
    exampleIntents: [
      "remove pendle liquidity into a token and PT",
      "exit pendle LP but keep the principal token",
      "withdraw pendle LP as two assets",
    ],
    chains: PENDLE_CHAINS,
  },

  "pendle.lp.addKeepYt": {
    embeddingText: embeddingText(
      `Add liquidity to a Pendle market and KEEP the yield token it produces, receiving both the pool position and the market's YT, across Pendle's 11 chains. ` +
      `Use when the user wants pool exposure without giving up the yield token: a plain add sells that YT into the pool, this one hands it to you. ` +
      `Deposits ONE token, never two; Pendle has no dual add. ` +
      `The market must not have expired. ` +
      `Quote it first with a dry run, then repeat the same call to broadcast. ` +
      `Example queries: add pendle liquidity and keep the YT, provide pendle LP without selling the yield token.`,
    ),
    aliases: ["pendle add liquidity keep yt", "keep yt lp add", "pendle lp plus yield token", "add pendle lp retain yt"],
    exampleIntents: [
      "add pendle liquidity and keep the YT",
      "provide pendle LP without selling the yield token",
      "deposit into a pendle pool keeping yield exposure",
    ],
    chains: PENDLE_CHAINS,
  },
} satisfies Record<string, ToolDiscoveryMetadata>;
