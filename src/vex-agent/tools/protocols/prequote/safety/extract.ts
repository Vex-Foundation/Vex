/**
 * Verdict computation + extraction (untrusted result.data → trusted prequote
 * fields). The quote result payload (`ToolResult.data`) is UNTRUSTED here: it is
 * re-validated with Zod at this boundary. We deliberately do NOT import the
 * handler-local `QuoteSafetyLeg` type from kyberswap/handlers/swap.ts (it is not
 * exported); we structurally re-validate instead.
 *
 * NEVER persist or log raw provider/HTTP/DB/error text - only bounded structural
 * labels.
 *
 * This file is the public entry point and routes a quote toolId to its VENUE
 * extractor; each venue family (its schemas, leg verdicts, and extraction) lives
 * in the same-named sibling folder: `extract/kyberswap.ts`, `extract/uniswap.ts`,
 * `extract/solana.ts`, `extract/pendle-pt.ts`, `extract/pendle-py.ts`,
 * `extract/pendle-lp.ts`, with the shared verdict primitives in
 * `extract/verdict.ts` and the Pendle thresholds in `extract/pendle-thresholds.ts`.
 */

import { extractEvm } from "./extract/kyberswap.js";
import { extractSolana } from "./extract/solana.js";
import { extractUniswap } from "./extract/uniswap.js";
import { extractVirtuals } from "./extract/virtuals.js";

import type { ExtractedQuote } from "./extract/extracted-quote.js";

export type { ExtractedQuote } from "./extract/extracted-quote.js";
export { extractPendleQuote } from "./extract/pendle-pt.js";
export type { ExtractedPendleQuote } from "./extract/pendle-pt.js";
export { extractPendlePyQuote } from "./extract/pendle-py.js";
export type { ExtractedPendlePyQuote } from "./extract/pendle-py.js";
export { extractPendleLpQuote } from "./extract/pendle-lp.js";
export { extractMorphoLendQuote } from "./extract/morpho-lend.js";
export type { ExtractedMorphoLendQuote } from "./extract/morpho-lend.js";
export type { ExtractedPendleLpQuote } from "./extract/pendle-lp.js";

/**
 * Validate + extract the prequote fields for a quote tool. Returns `null` when
 * the result payload does not structurally validate (recording is then
 * skipped). Exported for focused unit tests.
 */
export function extractQuote(
  toolId: string,
  params: Record<string, unknown>,
  data: Record<string, unknown>,
): ExtractedQuote | null {
  if (toolId === "kyberswap.swap.quote") return extractEvm(params, data);
  if (toolId === "uniswap.swap.quote") return extractUniswap(params, data);
  if (toolId === "solana.swap.quote") return extractSolana(params, data);
  // The Virtuals bonding-curve quote has NO aggregator safety block to borrow:
  // its pair is fixed and its real risk is the curve's own tax and the
  // anti-sniper window, both read on chain. Its extractor records those and
  // reports the verdict as `unknown` rather than claiming an audit it never ran.
  if (toolId === "virtuals.trade.quote") return extractVirtuals(params, data);
  return null;
}
