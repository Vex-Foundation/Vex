/**
 * Test harness for driving `verifyBuiltKyberSwap` against a REAL captured
 * `/route/build` response (see this directory's README for provenance).
 *
 * Every mutation goes through the SAME verified router ABI the guard decodes
 * with: decode the capture, change ONE field, re-encode. A "tampered build" in
 * these tests is therefore byte-shaped exactly like a real one, never a
 * hand-rolled struct that would only re-assert the test's own assumptions.
 */

import { expect } from "vitest";
import { decodeFunctionData, encodeFunctionData, getAddress, type Address, type Hex } from "viem";

import {
  META_AGGREGATION_ROUTER_V2_SWAP_ABI,
  type ApprovedKyberSwap,
  type BuiltKyberSwap,
} from "@tools/kyberswap/evm/swap-calldata-guard.js";
import { deriveRouteFirstHops } from "@tools/kyberswap/evm/swap-source-transfer-binding.js";
import {
  computeApprovedMinOut,
  KYBER_BUILD_REDERIVATION_ALLOWANCE_RAW,
} from "@tools/kyberswap/swap-price-floor.js";
import { META_AGGREGATION_ROUTER_V2, NATIVE_TOKEN_ADDRESS } from "@tools/kyberswap/constants.js";

/** The structural slice of a capture file the harness reads. */
export interface RouteBuildCapture {
  readonly request: {
    readonly tokenIn: string;
    readonly tokenOut: string;
    readonly recipient: string;
    readonly slippageTolerance: number;
  };
  readonly routeSummary: {
    readonly amountIn: string;
    readonly amountOut: string;
    /**
     * The route's paths. The harness derives the approved first-hop pools from
     * this with the SAME `deriveRouteFirstHops` the handler uses — a test that
     * re-implemented the derivation could stay green while the product refused.
     *
     * Optional because the three original captures (2026-07-25 06:28) trimmed
     * `routeSummary` to the two fields the harness then needed. Those three are
     * executor-shape builds, so an absent route is behaviourally the same as
     * the fail-closed empty hop set; captures taken after the pool-receiver fix
     * store the summary whole.
     */
    readonly route?: readonly (readonly { readonly pool: string; readonly swapAmount: string }[])[];
  };
  readonly routerAddress: string;
  readonly build: { readonly transactionValue: string; readonly data: string };
}

export type MutableDescription = {
  srcToken: Address;
  dstToken: Address;
  srcReceivers: readonly Address[];
  srcAmounts: readonly bigint[];
  feeReceivers: readonly Address[];
  feeAmounts: readonly bigint[];
  dstReceiver: Address;
  amount: bigint;
  minReturnAmount: bigint;
  flags: bigint;
  permit: Hex;
};

export interface DecodedCapture {
  readonly callTarget: Address;
  readonly approveTarget: Address;
  readonly targetData: Hex;
  readonly desc: MutableDescription;
  readonly clientData: Hex;
}

export function harnessFor(c: RouteBuildCapture) {
  const slippageBps = c.request.slippageTolerance;
  const srcIsNative = getAddress(c.request.tokenIn) === getAddress(NATIVE_TOKEN_ADDRESS);

  const decode = (): DecodedCapture => {
    const decoded = decodeFunctionData({
      abi: META_AGGREGATION_ROUTER_V2_SWAP_ABI,
      data: c.build.data as Hex,
    });
    expect(decoded.functionName).toBe("swap");
    return decoded.args[0] as unknown as DecodedCapture;
  };

  return {
    srcIsNative,
    decode,
    /** Re-encode the capture with a patched `SwapDescriptionV2`. */
    reencode: (patch: Partial<MutableDescription>): Hex => {
      const execution = decode();
      return encodeFunctionData({
        abi: META_AGGREGATION_ROUTER_V2_SWAP_ABI,
        functionName: "swap",
        args: [{ ...execution, desc: { ...execution.desc, ...patch } }],
      } as never);
    },
    /** The captured transaction, exactly as the provider returned it. */
    built: (over: Partial<BuiltKyberSwap> = {}): BuiltKyberSwap => ({
      calldata: c.build.data as Hex,
      routerAddress: c.routerAddress,
      transactionValue: c.build.transactionValue,
      ...over,
    }),
    /** What Vex approved: the floor computed from the ROUTE output. */
    approved: (over: Partial<ApprovedKyberSwap> = {}): ApprovedKyberSwap => ({
      expectedRouter: META_AGGREGATION_ROUTER_V2,
      recipient: getAddress(c.request.recipient) as Address,
      srcToken: getAddress(c.request.tokenIn) as Address,
      dstToken: getAddress(c.request.tokenOut) as Address,
      amountIn: BigInt(c.routeSummary.amountIn),
      srcIsNative,
      freshMinOutRaw: computeApprovedMinOut(c.routeSummary.amountOut, slippageBps),
      floorAllowanceRaw: KYBER_BUILD_REDERIVATION_ALLOWANCE_RAW,
      routeFirstHops: deriveRouteFirstHops(c.routeSummary.route ?? []),
      ...over,
    }),
  };
}
