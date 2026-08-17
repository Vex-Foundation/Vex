/**
 * Morpho Blue MARKET quote extraction (`morpho.market.quote`) - the preview that
 * authorizes one of the four borrow-lane executes (E3c).
 *
 * THE DIRECTION IS READ FROM THE RESULT, NOT THE PARAMS, and that is the point.
 * The recorder must record the direction the quote ACTUALLY priced; reading it
 * back from the params would let a mis-parsed or coerced direction record a
 * prequote for an operation the quote never previewed, which on this lane means
 * a collateral preview authorizing a borrow.
 *
 * WHAT A VERDICT CAN HONESTLY MEAN HERE. A Morpho Blue market is not a token
 * pair, so the honeypot machinery of the swap lane has nothing to check. What
 * the quote DOES know is whether the market passed Vex's own oracle/IRM vouching
 * and whether the operation's preflight simulation answered. The quote handler
 * already REFUSES an unvouched market outright, so a recorded row means the
 * market passed; the verdict is therefore `pass` or `unknown` and never `fail`.
 *
 * THE SIMULATION VERDICT IS DISCLOSED BUT DELIBERATELY NOT DEMOTED, exactly as
 * on the vault lane: a pulling operation simulates as a revert until the
 * exact-amount approval exists on chain, which is the normal state of every
 * first supply or repayment. Treating that as a safety signal would mark every
 * honest first operation suspicious.
 */

import { z } from "zod";

import type { SafetyVerdict } from "@vex-agent/db/repos/swap-prequotes.js";

import type { MorphoBorrowDirection } from "../../identity/morpho-borrow.js";
import { aggregateVerdict } from "./verdict.js";
import type { LegVerdict } from "./verdict.js";

const MorphoMarketQuoteResultSchema = z.object({
  toolId: z.literal("morpho.market.quote"),
  direction: z.enum(["supplyCollateral", "withdrawCollateral", "borrow", "repay"]),
  market: z.object({ marketId: z.string() }).passthrough(),
  leg: z
    .object({
      tokenAddress: z.string(),
      // `null` for a full-debt repayment, whose size is the position's own
      // share count and is decided on chain rather than named by the caller.
      amountRaw: z.string().nullable(),
    })
    .passthrough(),
  preflight: z.object({ verdict: z.string() }).passthrough(),
});

export interface ExtractedMorphoMarketQuote {
  readonly direction: MorphoBorrowDirection;
  /** The market the quote priced. Descriptive; the identity binds the param. */
  readonly marketId: string;
  /** The token THIS operation moves. Descriptive only. */
  readonly token: string;
  /**
   * The leg amount the quote reported, in RAW base units of `token`. `null` for
   * a full-debt repayment, which names its size in shares read from chain.
   */
  readonly amountRaw: string | null;
  readonly verdict: SafetyVerdict;
  readonly safetyDetail: Record<string, unknown>;
}

/**
 * Validate + extract a Morpho market quote. Returns null when the result payload
 * does not structurally validate, in which case recording is skipped and the
 * gate blocks the execute instead. Exported for focused unit tests.
 */
export function extractMorphoMarketQuote(
  data: Record<string, unknown>,
): ExtractedMorphoMarketQuote | null {
  const parsed = MorphoMarketQuoteResultSchema.safeParse(data);
  if (!parsed.success) return null;
  const quote = parsed.data;

  // The market gate is the only leg with a verdict to give. It ran and answered
  // (the handler would have failed the quote otherwise), so a recorded row means
  // the oracle and IRM were vouched for.
  const legs: LegVerdict[] = ["pass"];
  const safetyDetail: Record<string, unknown> = {
    marketVouched: true,
    preflight: { verdict: quote.preflight.verdict },
  };

  return {
    direction: quote.direction,
    marketId: quote.market.marketId,
    token: quote.leg.tokenAddress,
    amountRaw: quote.leg.amountRaw,
    verdict: aggregateVerdict(legs),
    safetyDetail,
  };
}
