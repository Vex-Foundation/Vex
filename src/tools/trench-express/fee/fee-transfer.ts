/**
 * The Trench fee leg itself — Vex's own native transfer to the treasury.
 *
 * ALWAYS native, unlike the bridge's two-branch builder: on Trench one leg of
 * every action is ETH by construction, and that is deliberately the leg the fee
 * is taken on. There is therefore no ERC-20 branch and no `data` field at all,
 * so a caller physically cannot send calldata with this value transfer.
 *
 * This is NOT a pull: the treasury never calls `transferFrom`, so no allowance
 * and no `approve` leg is involved.
 */

import { VexError, ErrorCodes } from "../../../errors.js";
import { TRENCH_FEE_RECEIVER_EVM } from "./constants.js";
import type { Address } from "viem";

/** A ready-to-sign fee transfer. No `data` — the native branch is the only branch. */
export interface TrenchFeeTransfer {
  readonly kind: "native";
  readonly to: Address;
  readonly value: bigint;
}

/**
 * Build the treasury transfer for `feeWei`. `feeWei` must be positive — a zero
 * fee has no leg at all (`VexFeeBpsSplit.charged`), and building one anyway
 * would burn gas to move nothing and add a meaningless activity row.
 */
export function buildTrenchFeeTransfer(feeWei: bigint): TrenchFeeTransfer {
  if (feeWei <= 0n) {
    throw new VexError(
      ErrorCodes.INVALID_AMOUNT,
      "Refusing to build a Trench fee transfer for a non-positive amount.",
    );
  }
  return { kind: "native", to: TRENCH_FEE_RECEIVER_EVM, value: feeWei };
}
