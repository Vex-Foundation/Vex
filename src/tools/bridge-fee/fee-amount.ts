/**
 * Bridge integrator-fee arithmetic — the ONE place `amountIn` is split into
 * what the venue is quoted for and what the treasury is paid.
 *
 * The arithmetic itself now lives in `tools/vex-fee/bps-split.ts`, shared with
 * every other Vex fee venue; this module is the BRIDGE's naming of it
 * (`bridgedRaw`) and stays the bridge's public entry point, so no caller
 * changed. Exact bigint math only: no `Number`, no float, no rounding surprise
 * at u64 scale. `fee = floor(amountIn × BRIDGE_FEE_BPS / 10000)`, and the venue
 * is always quoted for `amountIn − fee`, so the `amountOut` the agent is shown
 * is what the user actually receives.
 */

import { splitAmountForFeeBps } from "../vex-fee/bps-split.js";
import { BRIDGE_FEE_BPS } from "./constants.js";

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
  const split = splitAmountForFeeBps(amountRaw, { bps: BRIDGE_FEE_BPS, amountLabel: "Bridge amount" });
  return {
    totalRaw: split.totalRaw,
    feeRaw: split.feeRaw,
    bridgedRaw: split.netRaw,
    charged: split.charged,
  };
}
