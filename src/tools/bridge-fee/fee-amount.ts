/**
 * Bridge integrator-fee arithmetic — the ONE place `amountIn` is split into
 * what the venue is quoted for and what the treasury is paid.
 *
 * Exact bigint math only: no `Number`, no float, no rounding surprise at u64
 * scale. `fee = floor(amountIn × BRIDGE_FEE_BPS / 10000)`, and the venue is
 * always quoted for `amountIn − fee`, so the `amountOut` the agent is shown is
 * what the user actually receives.
 */

import { VexError, ErrorCodes } from "../../errors.js";
import { BRIDGE_FEE_BPS, BRIDGE_FEE_BPS_DENOMINATOR } from "./constants.js";

/**
 * How one bridge `amount` divides. `totalRaw` is what the user asked for and
 * what leaves the wallet in total; `bridgedRaw` is what the venue is quoted
 * for and deposits; `feeRaw` is Vex's cut.
 */
export interface BridgeFeeSplit {
  /** The caller's `amount`, in smallest units — the TOTAL debited. */
  readonly totalRaw: bigint;
  /** `floor(totalRaw × bps / 10000)`. Zero for dust amounts (see `charged`). */
  readonly feeRaw: bigint;
  /** `totalRaw − feeRaw` — the amount the venue is quoted for and deposits. */
  readonly bridgedRaw: bigint;
  /**
   * False when `feeRaw` floors to 0 (any amount below `10000 / bps` smallest
   * units). The fee leg is then SKIPPED entirely — a zero-value transfer would
   * burn gas, add a row, and move nothing.
   */
  readonly charged: boolean;
}

/**
 * Split a validated smallest-unit amount. Accepts the decimal string the
 * venue request builders already produce (or a bigint); anything non-positive
 * or unparseable is a typed rejection rather than a silent 0-fee bridge.
 */
export function splitBridgeAmountForFee(amountRaw: string | bigint): BridgeFeeSplit {
  const totalRaw = toPositiveBigint(amountRaw);
  const feeRaw = (totalRaw * BigInt(BRIDGE_FEE_BPS)) / BRIDGE_FEE_BPS_DENOMINATOR;
  return {
    totalRaw,
    feeRaw,
    bridgedRaw: totalRaw - feeRaw,
    charged: feeRaw > 0n,
  };
}

function toPositiveBigint(value: string | bigint): bigint {
  let parsed: bigint;
  if (typeof value === "bigint") {
    parsed = value;
  } else {
    const trimmed = value.trim();
    if (!/^(0[xX][0-9a-fA-F]+|\d+)$/.test(trimmed)) {
      throw new VexError(
        ErrorCodes.INVALID_AMOUNT,
        "Bridge amount must be a positive integer in smallest units (decimal or 0x hex).",
      );
    }
    parsed = BigInt(trimmed);
  }
  if (parsed <= 0n) {
    throw new VexError(ErrorCodes.INVALID_AMOUNT, "Bridge amount must be a positive value in smallest units.");
  }
  return parsed;
}
