/**
 * The Trench fee leg itself - Vex's own native transfer to the treasury.
 *
 * The mechanism now lives in `@tools/vex-fee/native-leg/transfer.ts`, shared
 * with every other venue on this lane; this file supplies the Trench venue and
 * keeps the venue-named entry point its call sites already import. Behaviour is
 * unchanged: still a native transfer with NO `data` field, so a caller
 * physically cannot send calldata with it, and still a refusal on a non-positive
 * amount.
 *
 * This is NOT a pull: the treasury never calls `transferFrom`, so no allowance
 * and no `approve` leg is involved.
 */

import { buildNativeFeeTransfer, type NativeFeeTransfer } from "../../vex-fee/native-leg/index.js";
import { TRENCH_FEE_VENUE } from "./venue.js";

/** A ready-to-sign fee transfer. No `data` - the native branch is the only branch. */
export type TrenchFeeTransfer = NativeFeeTransfer;

/**
 * Build the treasury transfer for `feeWei`. `feeWei` must be positive - a zero
 * fee has no leg at all (`VexFeeBpsSplit.charged`), and building one anyway
 * would burn gas to move nothing and add a meaningless activity row.
 */
export function buildTrenchFeeTransfer(feeWei: bigint): TrenchFeeTransfer {
  return buildNativeFeeTransfer(TRENCH_FEE_VENUE, feeWei);
}
