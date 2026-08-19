/**
 * The fee leg itself - Vex's own native transfer to the treasury.
 *
 * ALWAYS native, and deliberately without a `data` field: a caller physically
 * cannot send calldata with this value transfer. Every venue that uses this lane
 * has one native leg by construction and takes the fee there.
 *
 * This is NOT a pull: the treasury never calls `transferFrom`, so no allowance
 * and no `approve` leg is involved.
 */

import type { Address } from "viem";

import { VexError, ErrorCodes } from "../../../errors.js";
import type { NativeFeeVenue } from "./venue.js";

/** A ready-to-sign fee transfer. No `data` - the native branch is the only branch. */
export interface NativeFeeTransfer {
  readonly kind: "native";
  readonly to: Address;
  readonly value: bigint;
}

/**
 * Build the treasury transfer for `feeWei`. `feeWei` must be positive - a zero
 * fee has no leg at all (`VexFeeBpsSplit.charged`), and building one anyway
 * would burn gas to move nothing and add a meaningless activity row.
 */
export function buildNativeFeeTransfer(
  venue: Pick<NativeFeeVenue, "receiver" | "displayName">,
  feeWei: bigint,
): NativeFeeTransfer {
  if (feeWei <= 0n) {
    throw new VexError(
      ErrorCodes.INVALID_AMOUNT,
      `Refusing to build a ${venue.displayName} fee transfer for a non-positive amount.`,
    );
  }
  return { kind: "native", to: venue.receiver, value: feeWei };
}
