/**
 * The Trench fee's charge base and its split.
 *
 * Two responsibilities, kept adjacent because they are the same decision seen
 * from two sides: `trenchFeeBaseWei` says WHICH number the 25 bps applies to
 * (always the ETH leg — see `constants.ts` for the owner's reasoning), and
 * `splitTrenchEthForFee` applies the shared bps arithmetic to it.
 *
 * The split's `netRaw` is load-bearing on a BUY: the curve is quoted for
 * `amount − fee`, so the `expectedOut`/`minOut` the agent is shown are POST-fee
 * and are what actually arrives. It is NOT used on a launch — the fee is a
 * separate transaction and the launch's `msg.value` stays fully attributable to
 * its own proven components (creation fee + prebuy).
 */

import { splitAmountForFeeBps, type VexFeeBpsSplit } from "../../vex-fee/bps-split.js";
import { TRENCH_FEE_BPS, type TrenchFeeBasis } from "./constants.js";

/**
 * The ETH-leg amount the fee is charged on, named per side so a caller cannot
 * pass a sell's proceeds where a buy's spend belongs. The discriminated union
 * is the point: there is no field that accepts "whichever number you have".
 */
export type TrenchFeeBaseInput =
  | { readonly basis: "buy_eth_in"; readonly ethInWei: bigint }
  | { readonly basis: "sell_eth_out"; readonly ethOutWei: bigint }
  | { readonly basis: "launch_msg_value"; readonly msgValueWei: bigint };

export function trenchFeeBaseWei(input: TrenchFeeBaseInput): bigint {
  switch (input.basis) {
    case "buy_eth_in":
      return input.ethInWei;
    case "sell_eth_out":
      return input.ethOutWei;
    case "launch_msg_value":
      return input.msgValueWei;
  }
}

/**
 * `floor(baseWei × 25 / 10000)`, exact bigint. A base that floors to zero fee
 * reports `charged:false` and the caller SKIPS the leg entirely.
 */
export function splitTrenchEthForFee(baseWei: bigint): VexFeeBpsSplit {
  return splitAmountForFeeBps(baseWei, { bps: TRENCH_FEE_BPS, amountLabel: "Trench ETH-leg amount" });
}

export type { TrenchFeeBasis, VexFeeBpsSplit };
