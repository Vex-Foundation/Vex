/**
 * The EXACT Vex integrator fee a KyberSwap aggregator swap takes, in token
 * units.
 *
 * Sibling of `./swap-price-floor.ts`: one small module owning one money
 * derivation, stated once so the durable record and the agent-facing
 * disclosure can never quote different numbers.
 *
 * ── Why this is not just read off the provider response ─────────────────────
 *
 * `routeSummary.extraFee.feeAmount` looks like the obvious source and is the
 * wrong one. Vex always requests the fee in basis points (`isInBps: true`, see
 * `./constants.ts`), so the aggregator echoes the RATE back verbatim — the
 * literal string `"25"`. Recording that echo as an amount would have written 25
 * atomic units (0.000025 USDC) where the real fee on a 10 USDC swap is 25000
 * (0.025 USDC): a category error that reads as a plausible number, which is the
 * kind that survives review.
 *
 * The fee is computed ON CHAIN, by the router, as `floor(amount * bps / 10000)`
 * over the source token. This module states that same arithmetic in exact
 * bigint math, and it is a derivation from PROVEN inputs rather than an
 * assumption, because `./evm/swap-calldata-guard.ts` refuses to sign unless the
 * decoded calldata carries, all of them, before any key is touched:
 *
 *   - `desc.amount == approvedAmountIn`  (the base this fee is charged on),
 *   - `desc.feeAmounts == [KYBERSWAP_FEE_BPS]`,
 *   - `_FEE_IN_BPS` set        (rate mode, not absolute units),
 *   - `_FEE_ON_DST` clear      (charged on the SOURCE token),
 *   - partial fill forbidden   (no fee on input that never swapped).
 *
 * MEASURED against real captured bytes, not inferred: in
 * `src/__tests__/kyberswap/fixtures/route-build/base-usdc-to-native-50bps.json`
 * the decoded description carries `amount = 10000000` and
 * `srcAmounts = [9975000]` — the router keeps exactly `25000`, which is
 * `floor(10000000 * 25 / 10000)`. A live probe at `amountIn = 10000300`
 * (2026-07-25, base) returned a route swapping `9975300`, i.e. a fee of `25000`
 * where rounding-half-up would have produced `25001` — so the router TRUNCATES,
 * and so does this module.
 *
 * The fee is taken FROM the input: the user is debited `amountIn`, of which the
 * fee is a component and the remainder is what actually swaps. It is therefore
 * a subset of the row's `amount_in_raw`, never an extra charge beside it.
 */

import { KYBERSWAP_FEE_BPS } from "./constants.js";

/** Basis-point denominator. Local to the arithmetic that consumes it so the two cannot drift. */
const BPS_DENOMINATOR = 10_000n;

/**
 * `floor(amountInRaw * KYBERSWAP_FEE_BPS / 10000)` — the source-token amount the
 * router keeps, in raw atomic units.
 *
 * `amountInRaw` MUST be the non-negative approved input amount that the calldata
 * guard has pinned to `desc.amount`. A negative input is a programming error,
 * not a market condition, so it throws rather than silently producing a fee.
 */
export function computeKyberVexFeeRaw(amountInRaw: bigint): bigint {
  if (amountInRaw < 0n) {
    throw new RangeError(`amountInRaw must be a non-negative raw atomic amount: ${amountInRaw}`);
  }
  return (amountInRaw * BigInt(KYBERSWAP_FEE_BPS)) / BPS_DENOMINATOR;
}
