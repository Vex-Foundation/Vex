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
import { computeApprovedMinOut, toRouteRef } from "@tools/kyberswap/swap-price-floor.js";

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
 * the result satisfies both floor comparisons for a quote of
 * `quotedNetOutRaw`.
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
      },
    }],
  } as never);
}

/**
 * The persisted prequote row `kyberswap.swap.execute` re-reads for its approved
 * floor — the shape `findFreshMatchedSwapPrequote` returns.
 */
export function matchedPrequoteWithFloor(quotedNetOutRaw: string, slippageBps: number) {
  return {
    prequoteId: "prequote-test",
    routeRef: toRouteRef({
      quotedNetOutRaw,
      slippageBps,
      approvedMinOutRaw: computeApprovedMinOut(quotedNetOutRaw, slippageBps).toString(),
    }),
  };
}
