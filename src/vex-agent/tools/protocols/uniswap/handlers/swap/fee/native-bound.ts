/** A native input lower bound may only reduce the approved fee. */
import { formatUnits } from "viem";
import { UNISWAP_FEE_BPS } from "@tools/uniswap/fee/index.js";
import type { UniswapFeeLegPlan } from "./plan.js";

export function boundNativeFee(plan: UniswapFeeLegPlan, requested: bigint, bound: bigint, decimals: number): UniswapFeeLegPlan {
  if (!plan.isNativeValue || requested < 0n || bound < 0n) throw new Error("Invalid native fee bound");
  const base = bound < requested ? bound : requested;
  const calculated = base * BigInt(UNISWAP_FEE_BPS) / 10000n;
  const feeRaw = calculated < plan.feeRaw ? calculated : plan.feeRaw;
  return { ...plan, feeRaw, txParams: { ...plan.txParams, value: feeRaw },
    event: { ...plan.event, tokenIn: plan.event.tokenIn ? { ...plan.event.tokenIn,
      amountRaw: feeRaw.toString(), amountHuman: formatUnits(feeRaw, decimals) } : undefined } };
}
