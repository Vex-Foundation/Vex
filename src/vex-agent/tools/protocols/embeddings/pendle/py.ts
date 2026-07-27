/**
 * Retrieval metadata for Pendle PY tools (quote + mint/redeem).
 * Manifest at `pendle/manifests/py.ts` references entries by `toolId`.
 * Mutating passages open with an action verb (Mint / Redeem) per lint.
 */

import type { ToolDiscoveryMetadata } from "../../types.js";
import { embeddingText } from "../../_embedding-text.js";
import { PENDLE_CHAINS } from "../../pendle/discovery-text.js";

export const PENDLE_PY_DISCOVERY = {
  "pendle.py.quote": {
    embeddingText: embeddingText(
      `Preview a Pendle PY mint or pre-expiry redeem, on any of Pendle's 11 chains. ` +
      `A mint splits one payment token into an EQUAL amount of principal token (PT) and yield token (YT); a pre-expiry redeem burns an equal PT and YT pair back to a token. ` +
      `Use when the user wants the output, price impact, aggregator, or liquidity for splitting a token into PT plus YT, or for unwinding both legs before expiry. ` +
      `It records the safety preview mint and redeem require before broadcast. ` +
      `Example queries: quote minting pendle PT and YT, preview splitting a token into PT plus YT, preview redeeming PT and YT before expiry. Read-only.`,
    ),
    aliases: ["pendle mint quote", "pendle py quote", "preview mint pt yt", "preview redeem pt yt"],
    exampleIntents: ["quote minting pendle PT and YT", "preview redeeming PT and YT before expiry", "split token into PT and YT preview"],
    chains: PENDLE_CHAINS,
  },

  "pendle.py.mint": {
    embeddingText: embeddingText(
      `Mint a Pendle principal token (PT) and yield token (YT) together from one payment token, splitting it into an EQUAL amount of PT and YT in a single transaction, on any of Pendle's 11 chains. ` +
      `The PT is fixed yield to expiry; the YT is variable, leveraged yield that decays to zero at expiry. ` +
      `Use when the user wants both PT and YT rather than buying just one leg. ` +
      `Requires a fresh matching pendle.py.quote first; approval-gated and pins the canonical Pendle Router. ` +
      `Example queries: mint pendle PT and YT, split USDC into PT and YT, wrap a token into PT plus YT.`,
    ),
    aliases: ["pendle mint", "mint pt and yt", "split into pt yt", "wrap into pt yt"],
    exampleIntents: ["mint pendle PT and YT", "split a token into PT and YT", "wrap into pendle PT plus YT"],
    chains: PENDLE_CHAINS,
  },

  "pendle.py.redeem": {
    embeddingText: embeddingText(
      `Redeem a Pendle principal token (PT) and yield token (YT) pair back to a token BEFORE expiry, burning an EQUAL amount of PT and YT and returning the output token, on any of Pendle's 11 chains. ` +
      `This unwinds BOTH legs at once and needs equal PT and YT; a matured PT with no YT uses pendle.pt.redeem instead. ` +
      `Use when the user holds both legs and wants to exit the whole position before expiry. ` +
      `Requires a fresh matching pendle.py.quote first; approval-gated and pins the canonical Pendle Router. ` +
      `Example queries: redeem pendle PT and YT before expiry, unwind PT plus YT to USDC, burn a PT and YT pair.`,
    ),
    aliases: ["pendle py redeem", "redeem pt and yt", "unwind pt yt pair", "burn pt yt"],
    exampleIntents: ["redeem pendle PT and YT before expiry", "unwind PT plus YT to a token", "burn PT and YT pair"],
    chains: PENDLE_CHAINS,
  },
} satisfies Record<string, ToolDiscoveryMetadata>;

const EXPECTED_COUNT = 3;
if (Object.keys(PENDLE_PY_DISCOVERY).length !== EXPECTED_COUNT) {
  throw new Error(
    `PENDLE_PY_DISCOVERY has ${Object.keys(PENDLE_PY_DISCOVERY).length} entries, expected ${EXPECTED_COUNT}.`,
  );
}
