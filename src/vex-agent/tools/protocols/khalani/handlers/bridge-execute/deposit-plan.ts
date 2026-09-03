/**
 * `khalani.bridge` deposit-plan stage (steps 6 and 7b of the staged-execute
 * contract, split out in 0R.4, refactor-only): build the provider deposit
 * plan, materialize its signable legs, and classify their native-currency
 * exposure - all BEFORE the preview, before any recording and before any
 * signing. Planning is fault-TOLERATED here and fault-FATAL at step 8.
 */

import { getKhalaniClient } from "@tools/khalani/client.js";
import { planKhalaniDepositLegs, type KhalaniStagedLeg } from "@tools/khalani/bridge-executor.js";
import {
  authorizeKhalaniPlanNativeValue,
  type KhalaniPlanNativeValue,
} from "@tools/khalani/deposit-native-value.js";
import type { KhalaniChain } from "@tools/khalani/types.js";
import { VexError } from "../../../../../../errors.js";
import type { ToolResult } from "../../../../types.js";
import { khalaniFailureMessage } from "../bridge-support.js";
import type { FailPreSign } from "./types.js";

export interface KhalaniDepositPlanInput {
  readonly fromAddress: string;
  readonly quoteId: string;
  /** The route the handler selected from the quote it just took, never a param. */
  readonly routeId: string;
  readonly sourceChain: KhalaniChain;
  readonly chains: KhalaniChain[];
  readonly fromToken: string;
  readonly chargeFee: boolean;
  readonly feeRaw: bigint;
  /** What the venue was actually quoted for - the number Vex derived, never the provider's echo. */
  readonly bridgedAmountRaw: string;
}

export interface KhalaniPlannedDeposit {
  readonly outcome: "planned";
  /** `null` when the plan could not be materialized (a PERMIT2 plan legitimately throws). */
  readonly plannedLegs: KhalaniStagedLeg[] | null;
  readonly planError: unknown;
  /** `null` when the legs' native charges could not be classified on-chain. */
  readonly nativeCost: KhalaniPlanNativeValue | null;
  readonly nativeCostError: unknown;
}

export type KhalaniDepositPlanOutcome =
  | { readonly outcome: "failed"; readonly result: ToolResult }
  | KhalaniPlannedDeposit;

export async function buildKhalaniDepositPlan(
  input: KhalaniDepositPlanInput,
  failPreSign: FailPreSign,
): Promise<KhalaniDepositPlanOutcome> {
  // 6. Build deposit plan (needed for BOTH dryRun and execute).
  let plan;
  try {
    plan = await getKhalaniClient().buildDeposit({
      from: input.fromAddress,
      quoteId: input.quoteId,
      routeId: input.routeId,
      // No `depositMethod`: the selected route dictates its own deposit path,
      // and it was never something a caller could bind to a quote.
    });
  } catch (err) {
    const externalName = err instanceof VexError ? err.externalName : undefined;
    return {
      outcome: "failed",
      result: await failPreSign("bridge_failed", khalaniFailureMessage(err), { kind: "exception", externalName }),
    };
  }

  // 7b. Materialize AND classify the deposit plan BEFORE the preview and before
  // ANY recording or signing.
  //
  // This ordering is the point of the card, not a detail. Khalani's deposit
  // plan used to be built after the approval gate had already run, so the
  // provider's `tx.value` reached the signer having never been disclosed: a
  // deBridge deposit carrying 1e15 wei (~$1.86) that appears in NEITHER
  // `amountIn` NOR `amountOut` NOR `estimatedGas` was signed as-is. Classifying
  // here means the exposure is in the preview the agent reads, in the record
  // the intent persists, and in the fingerprint the signer re-checks.
  //
  // Planning is fault-TOLERATED here and fault-FATAL at step 8: a PERMIT2 plan
  // legitimately throws, and `dryRun` is the documented way to inspect a permit
  // payload, so a preview must still render. Nothing can be signed from a plan
  // that did not build.
  let plannedLegs: KhalaniStagedLeg[] | null = null;
  let planError: unknown = null;
  try {
    plannedLegs = planKhalaniDepositLegs(
      plan,
      input.sourceChain,
      input.chargeFee ? { tokenAddress: input.fromToken, feeRaw: input.feeRaw } : null,
    );
  } catch (err) {
    planError = err;
  }

  let nativeCost: KhalaniPlanNativeValue | null = null;
  let nativeCostError: unknown = null;
  if (plannedLegs !== null) {
    try {
      nativeCost = await authorizeKhalaniPlanNativeValue(plannedLegs, input.sourceChain, input.chains, {
        fromToken: input.fromToken,
        bridgedAmountRaw: input.bridgedAmountRaw,
      });
    } catch (err) {
      nativeCostError = err;
    }
  }

  return { outcome: "planned", plannedLegs, planError, nativeCost, nativeCostError };
}
