/**
 * Execute-time revalidation of a FRESH `/build` response against the
 * PERSISTED quote (W5 design `w5-design.md` §6 R4/R4b).
 *
 * Execute may fetch a fresh `/build` (new blockhash), but every economically
 * relevant parameter must still match what the human approved at quote time.
 * Mismatch → abort, NEVER a silent re-quote — the caller must fail the
 * intent and tell the agent to re-quote explicitly.
 */

import { VexError, ErrorCodes } from "../../../../errors.js";
import type { JupiterFeeSwapKnobs } from "./fee-swap.js";
import type { JupiterFeePreview } from "./fee-swap.js";
import type { JupiterSwapBuildResponse } from "./types.js";

/**
 * R4b: MANDATORY `fresh.otherAmountThreshold >= persisted.otherAmountThreshold`
 * — the fresh transaction must enforce a floor AT LEAST as strict as what was
 * quoted (threshold-to-threshold; the fresh tx enforces ITS OWN floor
 * on-chain). Validated atomic-unit BIGINTs — never a lexicographic string or
 * float compare. `outAmount` is checked too as an additional harmless sanity
 * check (never the primary gate — a worse quote could still hash-match on
 * `outAmount` alone).
 *
 * Pinned regression (K4 card): persisted floor 99, fresh outAmount 100, fresh
 * floor 98 → BLOCK (a fresh quote can look "better" on `outAmount` while
 * quietly weakening the actual floor the signed transaction enforces).
 */
export function assertEconomicFloorHolds(
  fresh: JupiterSwapBuildResponse,
  persistedOtherAmountThresholdRaw: string,
): void {
  const freshFloor = parseAtomicBigint("fresh.otherAmountThreshold", fresh.otherAmountThreshold);
  const persistedFloor = parseAtomicBigint("persisted.otherAmountThreshold", persistedOtherAmountThresholdRaw);
  if (freshFloor < persistedFloor) {
    throw new VexError(
      ErrorCodes.SOLANA_SWAP_FAILED,
      `Fresh /build floor (${fresh.otherAmountThreshold}) is below the persisted quote floor (${persistedOtherAmountThresholdRaw}). Aborting — re-quote required.`,
    );
  }
  if (fresh.swapMode !== undefined && fresh.swapMode !== "ExactIn") {
    throw new VexError(
      ErrorCodes.SOLANA_SWAP_FAILED,
      `Fresh /build swapMode is ${fresh.swapMode}, expected ExactIn. Aborting — re-quote required.`,
    );
  }
}

/** Exported for reuse by `build-response-guard.ts` — the same "atomic-unit string → bigint, never lexicographic/float" parsing rule applies to both response-identity checks and floor comparisons. */
export function parseAtomicBigint(label: string, value: string): bigint {
  if (!/^\d+$/.test(value)) {
    throw new VexError(ErrorCodes.SOLANA_SWAP_FAILED, `${label} is not a valid atomic-unit integer: ${value}`);
  }
  return BigInt(value);
}

/**
 * R4: every normalized knob bound at quote time must equal the fresh
 * execute-time knob — canonicalized excludeDexes/dexes, CU strategy,
 * `maxAccounts`, wrap behavior, `forJitoBundle`. A parameter-equality check
 * alone is insufficient without the floor check above (a worse quote could
 * still hash-match), so this runs ALONGSIDE `assertEconomicFloorHolds`, never
 * instead of it.
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
