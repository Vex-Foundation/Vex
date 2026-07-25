/**
 * Execute-time revalidation of a FRESH `/build` response against the
 * PERSISTED quote (W5 design `w5-design.md` §6 R4).
 *
 * Execute may fetch a fresh `/build` (new blockhash), but the SHAPE of the
 * trade — its mints, its input amount, its knobs, its fee destination, its
 * swap mode — must still be what was quoted. A shape mismatch → abort, NEVER
 * a silent re-quote: the caller fails the intent and tells the agent to
 * re-quote explicitly.
 *
 * What this module deliberately does NOT check is the PRICE. R4b used to
 * require `fresh.otherAmountThreshold >= persisted.otherAmountThreshold`;
 * since both thresholds are `out × (1 − slippage)` with the same slippage,
 * that reduced to `freshOut >= quotedOut` — a zero-tolerance rule that the
 * market breaks on its own, stacked on top of the tolerance the caller
 * already chose. It refused a real swap over a 0.0033% move and a re-quote
 * hits the same wall, so an autonomous agent could never converge. Removed by
 * owner decision (2026-07-25): `slippageBps` is the price protection, and the
 * agent raises it by parameter when a trade needs more room.
 */

import { VexError, ErrorCodes } from "../../../../errors.js";
import type { JupiterFeeSwapKnobs } from "./fee-swap.js";
import type { JupiterFeePreview } from "./fee-swap.js";
import type { JupiterSwapBuildResponse } from "./types.js";

/**
 * The fresh `/build` must still be the EXACT-INPUT swap that was quoted.
 *
 * This is a trade-shape surprise, not a price event: an exact-output build
 * spends an amount Vex never approved to reach a fixed output, which is a
 * different trade from the exact-in one the agent asked for. `swapMode` absent
 * is Jupiter's documented default (ExactIn) and passes.
 *
 * Not retryable at a different tolerance — raising `slippageBps` cannot turn
 * an ExactOut build into an ExactIn one — so the message sends the agent to a
 * fresh quote rather than to a wider tolerance.
 */
export function assertExactInSwapMode(fresh: JupiterSwapBuildResponse): void {
  if (fresh.swapMode !== undefined && fresh.swapMode !== "ExactIn") {
    throw new VexError(
      ErrorCodes.SOLANA_SWAP_FAILED,
      `Jupiter's /build returned swapMode ${fresh.swapMode}, not the ExactIn swap that was quoted. Nothing was signed. Get a fresh solana.swap.quote; do not retry this build.`,
    );
  }
}

/** Exported for reuse by `build-response-guard.ts` — the "atomic-unit string → bigint, never lexicographic/float" parsing rule every response-identity check shares. */
export function parseAtomicBigint(label: string, value: string): bigint {
  if (!/^\d+$/.test(value)) {
    throw new VexError(ErrorCodes.SOLANA_SWAP_FAILED, `${label} is not a valid atomic-unit integer: ${value}`);
  }
  return BigInt(value);
}

/**
 * R4: every normalized knob bound at quote time must equal the fresh
 * execute-time knob — canonicalized excludeDexes/dexes, CU strategy,
 * `maxAccounts`, wrap behavior, `forJitoBundle`. Bounds the ROUTE SHAPE the
 * fresh build is allowed to take; the price it comes back with is bounded by
 * `slippageBps` on-chain, not here.
 */
export function assertKnobsUnchanged(persisted: JupiterFeeSwapKnobs, fresh: JupiterFeeSwapKnobs): void {
  const mismatches: string[] = [];
  if ((persisted.dexes ?? "") !== (fresh.dexes ?? "")) mismatches.push("dexes");
  if ((persisted.excludeDexes ?? "") !== (fresh.excludeDexes ?? "")) mismatches.push("excludeDexes");
  if ((persisted.maxAccounts ?? null) !== (fresh.maxAccounts ?? null)) mismatches.push("maxAccounts");
  if (persisted.wrapAndUnwrapSol !== fresh.wrapAndUnwrapSol) mismatches.push("wrapAndUnwrapSol");
  if (persisted.forJitoBundle !== fresh.forJitoBundle) mismatches.push("forJitoBundle");
  if (String(persisted.computeUnitPricePercentile) !== String(fresh.computeUnitPricePercentile)) {
    mismatches.push("computeUnitPricePercentile");
  }
  if (persisted.tipLamports !== fresh.tipLamports) mismatches.push("tipLamports");
  if (mismatches.length > 0) {
    throw new VexError(
      ErrorCodes.SOLANA_SWAP_FAILED,
      `Execute knobs diverge from the persisted quote: ${mismatches.join(", ")}. Aborting — re-quote required.`,
    );
  }
}

/**
 * Fee-policy match (R4: "response fee fields ... match the hardcoded 25bps/
 * treasury policy"). `/build`'s response carries no dedicated platform-fee
 * field (verified against the live Jupiter docs — the fee is folded into the
 * swap instruction, not echoed back), so the check is a SELF-CONSISTENCY
 * assertion over what THIS module itself is about to sign: the freshly
 * re-derived `feeAccount`/`feeBps` (both re-computed by
 * `prepareFeeBearingJupiterSwap`, never read from the fresh `/build`
 * response) must equal the PERSISTED preview's — a divergence here means the
 * mint's owner-program (SPL vs Token-2022) changed between quote and
 * execute, which must abort rather than silently sign a different fee
 * destination.
 */
export function assertFeePolicyUnchanged(persisted: JupiterFeePreview, freshFeeMint: string, freshFeeAccount: string): void {
  if (persisted.feeMint !== freshFeeMint || persisted.feeAccount !== freshFeeAccount) {
    throw new VexError(
      ErrorCodes.SOLANA_SWAP_FAILED,
      "Fresh fee-account derivation diverges from the persisted quote's treasury ATA. Aborting — re-quote required.",
    );
  }
}

/**
 * Exact mints + input amount (R4: "exact mints + input amount"). Cheap,
 * string-exact — no unit conversion, since both sides are already atomic-unit
 * request params.
 */
export function assertMintsAndAmountUnchanged(
  persisted: { readonly inputMint: string; readonly outputMint: string; readonly amountRaw: string },
  fresh: { readonly inputMint: string; readonly outputMint: string; readonly amountRaw: string },
): void {
  if (
    persisted.inputMint !== fresh.inputMint
    || persisted.outputMint !== fresh.outputMint
    || persisted.amountRaw !== fresh.amountRaw
  ) {
    throw new VexError(
      ErrorCodes.SOLANA_SWAP_FAILED,
      "Execute mints/amount diverge from the persisted quote. Aborting — re-quote required.",
    );
  }
}
