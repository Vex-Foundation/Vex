/** Attach the separately settled fee, including the native-input bound policy. */
import { formatUnits } from "viem";
import type { UniswapFeeCharge } from "@tools/uniswap/fee/index.js";
import type { ConfirmedPriorLeg } from "@tools/evm-chains/dependent-leg-gas-estimate.js";
import { reduceUniswapNativeFee } from "@vex-agent/db/repos/agent-activity.js";
import type { ToolResult } from "../../../../../types.js";
import type { FinalizeConfirmedSwapOutcome } from "../finalize-confirmed.js";
import { abortRemainingPlans } from "../activity-recording.js";
import { boundNativeFee } from "./native-bound.js";
import { withFeeDisclosure } from "./attach.js";
import type { UniswapFeeLegPlan } from "./plan.js";
import { runUniswapFeeLeg, recordUniswapFeeNotCollected, uniswapFeeNotAttempted, uniswapFeeNotCharged,
  type UniswapFeeCollection, type UniswapFeeLegDebitGate, type RunUniswapFeeLegInput } from "./run.js";

export async function attachConfirmedUniswapFee(x: {
  readonly finalized: FinalizeConfirmedSwapOutcome;
  readonly feeCharge: UniswapFeeCharge;
  readonly feePlan: UniswapFeeLegPlan | null;
  readonly feeRowId: number | null;
  readonly executionId: number;
  readonly swapLegCount: number;
  readonly chainId: number;
  readonly tokenDecimals: number;
  readonly clients: Pick<RunUniswapFeeLegInput, "publicClient" | "walletClient">;
  readonly priorLeg: ConfirmedPriorLeg | undefined;
  readonly debitGate: UniswapFeeLegDebitGate;
  readonly feeCap: import("@tools/evm-chains/swap-native-debit.js").LegFeeCap;
}): Promise<ToolResult> {
  let disclosure = x.feeCharge.disclosure;
  const nativeBound = x.finalized.feeInputBoundRaw;
  if (nativeBound !== undefined) disclosure = { ...disclosure, swappedAmountRaw: nativeBound,
    swappedAmountBasis: "lower_bound", totalDebitedRaw: null, totalDebitedLowerBoundRaw: nativeBound,
    note: "Native input is a lower bound, not exact spend. Fee figures describe the approved plan until collection; actual total debit is unknown." };
  const attach = (collection: UniswapFeeCollection): ToolResult =>
    withFeeDisclosure({
      result: x.finalized.result,
      outputPayload: x.finalized.outputPayload,
      collection,
      disclosure,
    });

  // No fee applied at all - dust, or a token Vex declines to skim. There is no
  // row to finalize either, because none was ever planned.
  if (x.feePlan === null) {
    return attach(uniswapFeeNotCharged(disclosure.charged ? "no fee applies" : disclosure.reason));
  }
  // A fee DID apply but has no row to record it under. A different truth from
  // the line above, and the audit surface must tell them apart.
  if (x.feeRowId === null) {
    // Post-confirmation audit cleanup is BEST-EFFORT and never throws: the swap
    // is already confirmed on-chain, so a repository failure here is a
    // bookkeeping gap to DISCLOSE, never a reason to report it as failed.
    const cleanedUp = await abortRemainingPlans(x.executionId, x.swapLegCount, "the fee leg had no recorded row");
    return attach(
      uniswapFeeNotAttempted(
        cleanedUp
          ? "the fee leg had no recorded row, so nothing was signed"
          : "the fee leg had no recorded row, so nothing was signed; its audit rows could not be finalized either",
      ),
    );
  }

  if (x.finalized.result.data?.status === "confirmed_pending_amounts") {
    const reason = "the confirmed swap's executed amounts are not yet proven; no fee retry happens automatically";
    return attach(await recordUniswapFeeNotCollected(x.feeRowId, `No Vex fee was collected: ${reason}. The swap confirmed on-chain.`));
  }

  let plan = x.feePlan;
  if (nativeBound !== undefined) {
    try {
      plan = boundNativeFee(plan, x.feeCharge.totalRaw, BigInt(nativeBound), x.tokenDecimals);
      await reduceUniswapNativeFee(x.feeRowId, x.feePlan.feeRaw, plan.feeRaw, x.tokenDecimals);
      if (disclosure.charged) disclosure = { ...disclosure, feeAmountRaw: plan.feeRaw.toString(),
        feeAmountDecimal: formatUnits(plan.feeRaw, x.tokenDecimals), swappedAmountRaw: nativeBound,
        swappedAmountBasis: "lower_bound", totalDebitedRaw: null,
        note: "The native input is a lower bound. The fee plan is capped by that bound and the approved fee; total actual debit is not known exactly." };
      if (plan.feeRaw === 0n) return attach(await recordUniswapFeeNotCollected(x.feeRowId, "The native input bound yields zero fee. Nothing was signed and no fee retry happens automatically."));
    } catch {
      return attach(await recordUniswapFeeNotCollected(x.feeRowId, "The native fee reduction could not be recorded. The swap is unaffected; no fee retry happens automatically."));
    }
  }
  const collection = await runUniswapFeeLeg({
    plan,
    feeRowId: x.feeRowId,
    chainId: x.chainId,
    tokenDecimals: x.tokenDecimals,
    publicClient: x.clients.publicClient,
    walletClient: x.clients.walletClient,
    priorLeg: x.priorLeg,
    debitGate: x.debitGate,
    feeCap: x.feeCap,
  });
  if (nativeBound !== undefined) disclosure = { ...disclosure, totalDebitedLowerBoundRaw:
    (BigInt(nativeBound) + (["confirmed", "confirmed_unrecorded"].includes(collection.collection) ? plan.feeRaw : 0n)).toString() };
  return attach(collection);
}
