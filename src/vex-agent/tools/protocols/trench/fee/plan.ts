/**
 * Planning the Vex fee leg for a Trench Express action.
 *
 * The MECHANISM lives in `../../shared/native-fee-leg/plan.ts`, shared with
 * every venue on this lane; this file supplies the Trench venue and the one
 * decision that is genuinely Trench's - which of its three bases the fee is
 * charged on, and whether the net amount means anything for that basis.
 *
 * `null` still means NO FEE AT ALL: the 25 bps floored to zero at this size.
 * There is then no leg, no row, and no index in the intent. Callers must plan
 * the skipped disclosure (`buildTrenchFeeSkippedDisclosure`) rather than a zero
 * one.
 *
 * The fee row is planned as the LAST event of the execution and driven OUTSIDE
 * whatever loop runs the action's own legs - see `run.ts` for why the ordering
 * is the safety property.
 */

import { TRENCH_FEE_VENUE, trenchFeeBaseWei, type TrenchFeeBaseInput } from "@tools/trench-express/fee/index.js";
import type { TrenchFeeBasis } from "@tools/trench-express/fee/index.js";

import { planNativeFeeLeg } from "../../shared/native-fee-leg/plan.js";
import type { NativeFeeLegPlan, PlanNativeFeeLegInput } from "../../shared/native-fee-leg/plan.js";

/** The parent execution's kind - the arm of the kind/role CHECK the fee row lands on. */
export type TrenchFeeParentKind = "swap" | "launch";

export interface PlanTrenchFeeLegInput {
  /** Which ETH leg the fee is charged on, and its amount. */
  readonly base: TrenchFeeBaseInput;
  readonly parentKind: TrenchFeeParentKind;
  readonly chainId: number;
  /** The shared native sentinel - the fee row's identity token. */
  readonly nativeAddress: PlanNativeFeeLegInput<TrenchFeeBasis>["nativeAddress"];
  readonly walletAddress: PlanNativeFeeLegInput<TrenchFeeBasis>["walletAddress"];
  readonly sessionId: string;
  /** Nullable ESTIMATE, stamped on the fee row ONLY. Omit rather than guess. */
  readonly usdVexFeeEst?: string | undefined;
}

export type TrenchFeeLegPlan = NativeFeeLegPlan<TrenchFeeBasis>;

/**
 * Plan the fee leg, or `null` when the fee floors to zero. Throws only on a
 * non-positive base, which is a programming error rather than a market
 * condition (`splitTrenchEthForFee` refuses it by name).
 */
export function planTrenchFeeLeg(input: PlanTrenchFeeLegInput): TrenchFeeLegPlan | null {
  return planNativeFeeLeg(TRENCH_FEE_VENUE, {
    basis: input.base.basis,
    baseWei: trenchFeeBaseWei(input.base),
    // Only a BUY is quoted for `amount - fee`; a sell's proceeds and a launch's
    // `msg.value` are what they are, and the fee is a separate transaction.
    netApplies: input.base.basis === "buy_eth_in",
    parentKind: input.parentKind,
    chainId: input.chainId,
    nativeAddress: input.nativeAddress,
    walletAddress: input.walletAddress,
    sessionId: input.sessionId,
    usdVexFeeEst: input.usdVexFeeEst,
  });
}
