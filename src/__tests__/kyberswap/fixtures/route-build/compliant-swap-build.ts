/**
 * Test helper: a KyberSwap build that PASSES `verifyBuiltKyberSwap`, derived
 * from the real captured `/route/build` response in this directory.
 *
 * `kyberswap.swap.execute` decodes and asserts the build calldata before
 * signing, so any test that drives the handler past the pre-sign gate needs
 * calldata that genuinely decodes. Rather than let each test hand-roll a
 * struct (which would only re-assert its own assumptions), this re-encodes the
 * REAL capture — same function, same fee line, same flags, same executor
 * payload — with only the identity fields the calling test uses patched in.
 *
 * Use `compliantSwapCalldata` for tests about something else (staged
 * broadcast, activity bookkeeping, error scrubbing). Tests about the gate
 * ITSELF should mutate the capture directly so the tampering is visible in the
 * test body.
 */

import { decodeFunctionData, encodeFunctionData, getAddress, type Hex } from "viem";

import { META_AGGREGATION_ROUTER_V2_SWAP_ABI } from "@tools/kyberswap/evm/swap-calldata-guard.js";
import { KYBERSWAP_FEE_BPS, NATIVE_TOKEN_ADDRESS } from "@tools/kyberswap/constants.js";
import { computeApprovedMinOut } from "@tools/kyberswap/swap-price-floor.js";

import capture from "./base-usdc-to-native-50bps.json" with { type: "json" };

export interface CompliantSwapBuildInput {
  /** Plain strings — normalized (and validated) with `getAddress` here. */
  readonly srcToken: string;
  readonly dstToken: string;
  readonly dstReceiver: string;
  readonly amountIn: bigint;
  /** Raw quoted output the swap is priced against. */
  readonly quotedNetOutRaw: string;
  readonly slippageBps: number;
}

/**
 * Real captured calldata with the identity + floor fields swapped for the
 * caller's. The embedded floor is derived the way the provider derives it, so
 * the result satisfies the guard's floor comparison for a route whose output
 * is `quotedNetOutRaw`.
 */
export function compliantSwapCalldata(input: CompliantSwapBuildInput): Hex {
  const decoded = decodeFunctionData({
    abi: META_AGGREGATION_ROUTER_V2_SWAP_ABI,
    data: capture.build.data as Hex,
  });
  const execution = decoded.args[0] as unknown as Record<string, unknown>;
  const desc = execution.desc as Record<string, unknown>;
  return encodeFunctionData({
    abi: META_AGGREGATION_ROUTER_V2_SWAP_ABI,
    functionName: "swap",
    args: [{
      ...execution,
      desc: {
        ...desc,
        srcToken: getAddress(input.srcToken),
        dstToken: getAddress(input.dstToken),
        dstReceiver: getAddress(input.dstReceiver),
        amount: input.amountIn,
        minReturnAmount: computeApprovedMinOut(input.quotedNetOutRaw, input.slippageBps),
        ...sourceTransfersFor(input.srcToken, input.amountIn, execution.callTarget as string),
      },
    }],
  } as never);
}

/**
 * The input-token transfer list a real build carries for `amountIn`, which the
 * pre-sign guard binds: one transfer to the executor being called, for the
 * amount net of the integrator fee — or nothing at all when the input is
 * native and rides in `msg.value` instead. Patching `amount` without this would
 * leave the capture's original figure behind and the guard would (correctly)
 * refuse the result.
 */
function sourceTransfersFor(srcToken: string, amountIn: bigint, callTarget: string) {
  if (getAddress(srcToken) === getAddress(NATIVE_TOKEN_ADDRESS)) {
    return { srcReceivers: [], srcAmounts: [] };
  }
  return {
    srcReceivers: [getAddress(callTarget)],
    // Fee floors, then the remainder — the router's own `_takeFee` order.
    srcAmounts: [amountIn - (amountIn * BigInt(KYBERSWAP_FEE_BPS)) / 10_000n],
  };
}
