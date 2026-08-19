/**
 * Agent-facing disclosure of the Vex Trench fee.
 *
 * The SHAPE and the builders now live in `@tools/vex-fee/native-leg/`, shared
 * with every venue on this lane; this file supplies the Trench venue (rate,
 * treasury, and the sentences describing each leg - see `./venue.ts`) and keeps
 * the venue-named entry points its call sites already import.
 *
 * ONE shape across `trench.trade_quote`, `trench.launch_preview` and both
 * execute handlers, so the model sees identical field names wherever it meets
 * the fee. Field names mirror `bridge-fee/fee-disclosure.ts` deliberately - the
 * agent already reads that shape on every bridge.
 *
 * Two things this disclosure must be honest about, and both are why it carries
 * more than a number:
 *
 *   `basis`   - WHICH leg the fee came out of. On a SELL that is the ETH the
 *               user RECEIVES, not the token they sent, which is a deviation
 *               from `currency_in` and would be misleading if merely implied.
 *   `note`    - that the fee leg runs AFTER the trade or launch confirms, as a
 *               separate transaction. A trade that does not happen is never
 *               charged, and a fee that fails leaves the trade untouched.
 *
 * The fee is disclosure, NOT an approval gate (owner decision, as on bridges).
 */

import {
  buildNativeFeeDisclosure,
  buildNativeFeeSkippedDisclosure,
  type NativeFeeDisclosure,
} from "../../vex-fee/native-leg/index.js";
import type { TrenchFeeBasis } from "./constants.js";
import { TRENCH_FEE_VENUE } from "./venue.js";

export type TrenchFeeDisclosure = NativeFeeDisclosure<TrenchFeeBasis>;

/**
 * The net amount is only meaningful on a BUY: there the curve is quoted for
 * `amount - fee`, so the disclosed `expectedOut`/`minOut` are post-fee. On a
 * SELL the fee comes out of the proceeds, and on a LAUNCH it is a separate
 * transaction that does not reduce `msg.value`.
 */
function netApplies(basis: TrenchFeeBasis): boolean {
  return basis === "buy_eth_in";
}

export function buildTrenchFeeDisclosure(input: {
  readonly basis: TrenchFeeBasis;
  readonly baseWei: bigint;
  readonly feeWei: bigint;
  /** Only meaningful on a BUY - see `netApplies`. */
  readonly netWei?: bigint | undefined;
  readonly feeUsdEstimate?: string | undefined;
}): TrenchFeeDisclosure {
  return buildNativeFeeDisclosure(TRENCH_FEE_VENUE, { ...input, netApplies: netApplies(input.basis) });
}

/**
 * No fee was taken. Either the 25 bps floored to zero, or - with `baseWei`
 * omitted - Vex could not prove a base at all and therefore took nothing rather
 * than charging a percentage of an estimate.
 */
export function buildTrenchFeeSkippedDisclosure(input: {
  readonly basis: TrenchFeeBasis;
  readonly baseWei?: bigint | undefined;
  readonly reason: string;
}): TrenchFeeDisclosure {
  return buildNativeFeeSkippedDisclosure(TRENCH_FEE_VENUE, input);
}
