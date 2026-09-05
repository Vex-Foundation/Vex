/**
 * The ONE place a Vex integrator fee is computed from a basis-point rate.
 *
 * WHY IT EXISTS. `(amount * 25n) / 10_000n` had been written out independently
 * at four venues — `bridge-fee/fee-amount.ts`, `kyberswap/swap-vex-fee.ts`,
 * `jupiter/fee-swap.ts` and `kyberswap/evm/swap-source-transfer-binding.ts` —
 * and a launchpad would have been the fifth. Four copies of a real-funds rounding
 * rule is four chances for one of them to round instead of floor, or to use a
 * denominator of 1000 (a curve Diamond's own trade-fee base, notably) and
 * overcharge a user by 10×. The arithmetic is stated here, once.
 *
 * PROPERTIES, all of which the venues depend on:
 *   - EXACT bigint. No `Number`, no float. A u128 amount must not collapse into
 *     a rounded double.
 *   - TRUNCATING (`floor`). A remainder is never rounded up: the user is never
 *     charged a smallest unit Vex did not earn.
 *   - `fee + net === total`, always, so `total` stays the number the caller
 *     asked about.
 *   - `charged:false` when the fee floors to 0. The caller SKIPS the fee leg
 *     entirely — a zero-value transfer burns gas, adds an activity row, and
 *     moves nothing.
 *
 * The RATE is not this module's business: it is a product-owner constant at
 * each venue and is passed in. This module only refuses a rate that is not a
 * whole number of basis points in [0, 10000], because such a rate cannot
 * describe a fee at all.
 */

import { VexError, ErrorCodes } from "../../errors.js";

/** Basis-point base. The only denominator any Vex fee is allowed to use. */
export const VEX_FEE_BPS_DENOMINATOR = 10_000n;

export interface VexFeeBpsSplit {
  /** What the caller asked about — the TOTAL the split accounts for. */
  readonly totalRaw: bigint;
  /** `floor(totalRaw × bps / 10000)`. Zero for dust amounts (see `charged`). */
  readonly feeRaw: bigint;
  /** `totalRaw − feeRaw`. */
  readonly netRaw: bigint;
  /** False when `feeRaw` floored to 0 — the fee leg is then skipped entirely. */
  readonly charged: boolean;
}

export interface VexFeeBpsSplitOptions {
  /** Whole basis points, 0–10000. A product-owner constant, never model input. */
  readonly bps: number;
  /** How the amount is named in a refusal, e.g. "Bridge amount". */
  readonly amountLabel?: string;
}

/**
 * Split a positive smallest-unit amount into Vex's fee and the remainder.
 * Accepts the decimal string venue request builders produce, a `0x` hex string,
 * or a bigint; anything non-positive or unparseable is a typed rejection rather
 * than a silent 0-fee charge.
 */
export function splitAmountForFeeBps(
  amountRaw: string | bigint,
  options: VexFeeBpsSplitOptions,
): VexFeeBpsSplit {
  const bps = assertWholeBps(options.bps);
  const totalRaw = toPositiveBigint(amountRaw, options.amountLabel ?? "Amount");
  const feeRaw = (totalRaw * BigInt(bps)) / VEX_FEE_BPS_DENOMINATOR;
  return {
    totalRaw,
    feeRaw,
    netRaw: totalRaw - feeRaw,
    charged: feeRaw > 0n,
  };
}

function assertWholeBps(bps: number): number {
  if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) {
    throw new VexError(
      ErrorCodes.INVALID_AMOUNT,
      "A Vex fee rate must be a whole number of basis points between 0 and 10000.",
    );
  }
  return bps;
}

function toPositiveBigint(value: string | bigint, amountLabel: string): bigint {
  let parsed: bigint;
  if (typeof value === "bigint") {
    parsed = value;
  } else {
    const trimmed = value.trim();
    if (!/^(0[xX][0-9a-fA-F]+|\d+)$/.test(trimmed)) {
      throw new VexError(
        ErrorCodes.INVALID_AMOUNT,
        `${amountLabel} must be a positive integer in smallest units (decimal or 0x hex).`,
      );
    }
    parsed = BigInt(trimmed);
  }
  if (parsed <= 0n) {
    throw new VexError(ErrorCodes.INVALID_AMOUNT, `${amountLabel} must be a positive value in smallest units.`);
  }
  return parsed;
}
