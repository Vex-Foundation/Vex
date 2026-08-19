/**
 * Running the Vex fee leg for Trench - AFTER the trade or launch confirmed, and
 * never before.
 *
 * The MECHANISM, and every invariant it enforces, lives in
 * `../../shared/native-fee-leg/run.ts`; this file binds it to the Trench venue
 * and keeps the venue-named entry points its call sites already import.
 *
 * The invariants, restated because they are the reason the ordering exists:
 *
 *   - A REVERTED or AMBIGUOUS trade/launch means the runner is never called at
 *     all: the fee is not signed, and the caller finalizes the fee row as
 *     never-attempted.
 *   - A FAILED fee leaves the trade UNAFFECTED. Nothing throws, and no caller
 *     may mark a confirmed trade failed because its fee did not land.
 *   - An AMBIGUOUS fee is NEVER retried; a blind retry of an unconfirmed
 *     transfer could charge the user twice.
 */

import { TRENCH_FEE_VENUE } from "@tools/trench-express/fee/index.js";

import {
  nativeFeeNotAttempted,
  nativeFeeNotCharged,
  runNativeFeeLeg,
  type NativeFeeCollection,
  type RunNativeFeeLegInput,
} from "../../shared/native-fee-leg/run.js";
import type { TrenchFeeLegPlan } from "./plan.js";

export type TrenchFeeCollection = NativeFeeCollection;

export interface RunTrenchFeeLegInput extends Omit<RunNativeFeeLegInput, "plan"> {
  readonly plan: TrenchFeeLegPlan;
}

/** Never throws. Every path returns a report. */
export async function runTrenchFeeLeg(input: RunTrenchFeeLegInput): Promise<TrenchFeeCollection> {
  return runNativeFeeLeg(TRENCH_FEE_VENUE, input);
}

/** The fee row exists but the action never reached the point where it is taken. */
export const trenchFeeNotAttempted = nativeFeeNotAttempted;

/** There was no fee to take at all - the 25 bps floored to zero at this size. */
export const trenchFeeNotCharged = nativeFeeNotCharged;
