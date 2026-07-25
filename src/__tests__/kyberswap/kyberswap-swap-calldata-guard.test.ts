/**
 * `verifyBuiltKyberSwap` — the pre-sign gate on KyberSwap's opaque build
 * calldata.
 *
 * Every case runs against a REAL captured `/route/build` response
 * (`fixtures/route-build/`, see its README for provenance). Mutations are made
 * by decoding that capture, changing ONE field, and re-encoding through the
 * SAME verified router ABI the guard decodes with — so a "tampered build" in
 * these tests is byte-shaped exactly like a real one, not a hand-rolled struct.
 */

import { describe, it, expect } from "vitest";
import { decodeFunctionData, encodeFunctionData, getAddress, type Address, type Hex } from "viem";

import {
  verifyBuiltKyberSwap,
  META_AGGREGATION_ROUTER_V2_SWAP_ABI,
  type ApprovedKyberSwap,
  type BuiltKyberSwap,
} from "@tools/kyberswap/evm/swap-calldata-guard.js";
import {
  computeApprovedMinOut,
  KYBER_BUILD_REDERIVATION_ALLOWANCE_RAW,
} from "@tools/kyberswap/swap-price-floor.js";
import {
  META_AGGREGATION_ROUTER_V2,
  KYBERSWAP_FEE_RECEIVER,
  NATIVE_TOKEN_ADDRESS,
} from "@tools/kyberswap/constants.js";

import capture from "./fixtures/route-build/base-usdc-to-native-50bps.json" with { type: "json" };

const SLIPPAGE_BPS = capture.request.slippageTolerance;
const RECIPIENT = getAddress(capture.request.recipient) as Address;
const SRC_TOKEN = getAddress(capture.request.tokenIn) as Address;
const DST_TOKEN = getAddress(capture.request.tokenOut) as Address;
const AMOUNT_IN = BigInt(capture.routeSummary.amountIn);

/** The captured transaction, exactly as the provider returned it. */
function builtFromCapture(over: Partial<BuiltKyberSwap> = {}): BuiltKyberSwap {
  return {
    calldata: capture.build.data as Hex,
    routerAddress: capture.routerAddress,
    transactionValue: capture.build.transactionValue,
    ...over,
  };
}

/** What Vex approved for that capture: the floor computed from the ROUTE output. */
function approvedFromCapture(over: Partial<ApprovedKyberSwap> = {}): ApprovedKyberSwap {
  const floor = computeApprovedMinOut(capture.routeSummary.amountOut, SLIPPAGE_BPS);
  return {
    expectedRouter: META_AGGREGATION_ROUTER_V2,
    recipient: RECIPIENT,
    srcToken: SRC_TOKEN,
    dstToken: DST_TOKEN,
    amountIn: AMOUNT_IN,
    srcIsNative: false,
    approvedMinOutRaw: floor,
    freshMinOutRaw: floor,
    floorAllowanceRaw: KYBER_BUILD_REDERIVATION_ALLOWANCE_RAW,
    ...over,
  };
}

type MutableDescription = {
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

interface DecodedCapture {
  readonly callTarget: Address;
  readonly approveTarget: Address;
  readonly targetData: Hex;
  readonly desc: MutableDescription;
  readonly clientData: Hex;
}

function decodeCapture(): DecodedCapture {
  const decoded = decodeFunctionData({
    abi: META_AGGREGATION_ROUTER_V2_SWAP_ABI,
    data: capture.build.data as Hex,
  });
  expect(decoded.functionName).toBe("swap");
  return decoded.args[0] as unknown as DecodedCapture;
}

/** Re-encode the capture with a patched `SwapDescriptionV2`. */
function reencode(patch: Partial<MutableDescription>): Hex {
  const execution = decodeCapture();
  return encodeFunctionData({
    abi: META_AGGREGATION_ROUTER_V2_SWAP_ABI,
    functionName: "swap",
    args: [{ ...execution, desc: { ...execution.desc, ...patch } }],
  } as never);
}

describe("verifyBuiltKyberSwap — real captured build", () => {
  it("the capture decodes to the fee line, flags and floor Vex expects", () => {
    const { desc, approveTarget } = decodeCapture();
    expect(desc.feeReceivers.map((a) => getAddress(a))).toEqual([getAddress(KYBERSWAP_FEE_RECEIVER)]);
    expect(desc.feeAmounts).toEqual([25n]);
    expect(desc.flags).toBe(640n); // 0x280 = 0x200 | _FEE_IN_BPS
    expect(approveTarget).toBe("0x0000000000000000000000000000000000000000");
    expect(getAddress(desc.dstReceiver)).toBe(RECIPIENT);
    expect(getAddress(desc.dstToken)).toBe(getAddress(NATIVE_TOKEN_ADDRESS));
    // The provider derives its floor from its OWN re-simulated output, which is
    // one unit below the route summary's — the reason the allowance exists.
    expect(desc.minReturnAmount).toBe(computeApprovedMinOut(capture.build.amountOut, SLIPPAGE_BPS));
    expect(BigInt(capture.routeSummary.amountOut) - BigInt(capture.build.amountOut)).toBe(1n);
  });

  it("a compliant build passes — nothing about a real, honest build is refused", () => {
    expect(verifyBuiltKyberSwap(builtFromCapture(), approvedFromCapture())).toEqual({ ok: true });
  });

  it("refuses when minReturnAmount is below the APPROVED quote-time floor", () => {
    const { desc } = decodeCapture();
    const calldata = reencode({ minReturnAmount: desc.minReturnAmount - 1n });
    const verdict = verifyBuiltKyberSwap(builtFromCapture({ calldata }), approvedFromCapture());

    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.kind).toBe("price_floor");
    expect(verdict.reason).toContain("you approved");
  });

  it("refuses a floor weakened to a 50% tolerance, the range the provider actually accepts", () => {
    const calldata = reencode({
      minReturnAmount: computeApprovedMinOut(capture.build.amountOut, 5000),
    });
    const verdict = verifyBuiltKyberSwap(builtFromCapture({ calldata }), approvedFromCapture());

    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.kind).toBe("price_floor");
  });

  it("refuses when minReturnAmount is below the FRESH route's floor even if the persisted floor is stale-low", () => {
    const { desc } = decodeCapture();
    const verdict = verifyBuiltKyberSwap(
      builtFromCapture(),
      approvedFromCapture({
        approvedMinOutRaw: 0n, // a permissive persisted floor must not rescue it
        freshMinOutRaw: desc.minReturnAmount + KYBER_BUILD_REDERIVATION_ALLOWANCE_RAW + 1n,
      }),
    );

    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.kind).toBe("price_floor");
    expect(verdict.reason).toContain("the route now allows");
  });

  it("refuses a fee paid to an address that is not the Vex treasury", () => {
    const calldata = reencode({ feeReceivers: ["0x00000000000000000000000000000000DeaDBeef"] });
    const verdict = verifyBuiltKyberSwap(builtFromCapture({ calldata }), approvedFromCapture());

    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.kind).toBe("build_integrity");
    expect(verdict.reason).toContain("unexpected receiver");
  });

  it("refuses a fee larger than the 25 bps Vex constant", () => {
    const calldata = reencode({ feeAmounts: [250n] });
    const verdict = verifyBuiltKyberSwap(builtFromCapture({ calldata }), approvedFromCapture());

    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.kind).toBe("build_integrity");
    expect(verdict.reason).toContain("25 bps");
  });

  it("refuses a build with _PARTIAL_FILL set — the fee would be charged on unswapped funds", () => {
    const { desc } = decodeCapture();
    const calldata = reencode({ flags: desc.flags | 0x01n });
    const verdict = verifyBuiltKyberSwap(builtFromCapture({ calldata }), approvedFromCapture());

    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.kind).toBe("build_integrity");
    expect(verdict.reason).toContain("partial fill");
  });

  it("refuses a build with _FEE_ON_DST set — Vex always charges on the source token", () => {
    const { desc } = decodeCapture();
    const calldata = reencode({ flags: desc.flags | 0x40n });
    const verdict = verifyBuiltKyberSwap(builtFromCapture({ calldata }), approvedFromCapture());

    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.reason).toContain("destination token");
  });

  it("refuses a build that drops _FEE_IN_BPS — the fee would be absolute units, not bps", () => {
    const { desc } = decodeCapture();
    const calldata = reencode({ flags: desc.flags & ~0x80n });
    const verdict = verifyBuiltKyberSwap(builtFromCapture({ calldata }), approvedFromCapture());

    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.reason).toContain("basis points");
  });

  it("refuses a build that redirects the output to another address", () => {
    const calldata = reencode({ dstReceiver: "0x00000000000000000000000000000000DeaDBeef" });
    const verdict = verifyBuiltKyberSwap(builtFromCapture({ calldata }), approvedFromCapture());

    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.reason).toContain("unapproved address");
  });

  it("refuses a build that spends a different input amount", () => {
    const { desc } = decodeCapture();
    const calldata = reencode({ amount: desc.amount * 2n });
    const verdict = verifyBuiltKyberSwap(builtFromCapture({ calldata }), approvedFromCapture());

    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.reason).toContain("not the approved");
  });

  it("refuses a value-bearing call on an ERC-20 sell", () => {
    const verdict = verifyBuiltKyberSwap(
      builtFromCapture({ transactionValue: "1000000000000000000" }),
      approvedFromCapture(),
    );

    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.kind).toBe("build_integrity");
    expect(verdict.reason).toContain("native wei");
  });

  it("refuses a build targeting a router Vex did not approve", () => {
    const verdict = verifyBuiltKyberSwap(
      builtFromCapture({ routerAddress: "0x00000000000000000000000000000000DeaDBeef" }),
      approvedFromCapture(),
    );

    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.reason).toContain("router Vex did not approve");
  });

  it("refuses calldata that is not a router swap call at all", () => {
    const verdict = verifyBuiltKyberSwap(
      builtFromCapture({ calldata: "0xdeadbeef" }),
      approvedFromCapture(),
    );

    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.reason).toContain("could not decode");
  });

  it("refuses a build that grants an ERC-20 allowance to an unexpected spender", () => {
    const execution = decodeCapture();
    const calldata = encodeFunctionData({
      abi: META_AGGREGATION_ROUTER_V2_SWAP_ABI,
      functionName: "swap",
      args: [{ ...execution, approveTarget: "0x00000000000000000000000000000000DeaDBeef" }],
    } as never);
    const verdict = verifyBuiltKyberSwap(builtFromCapture({ calldata }), approvedFromCapture());

    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.reason).toContain("unexpected token spender");
  });
});

describe("computeApprovedMinOut", () => {
  it("floors with exact bigint math, never floats", () => {
    // 5372283667499173 * 0.995 = 5345422249161677.135 → floors DOWN.
    expect(computeApprovedMinOut("5372283667499173", 50)).toBe(5345422249161677n);
  });

  it("a zero tolerance keeps the full quoted output", () => {
    expect(computeApprovedMinOut("1000", 0)).toBe(1000n);
  });

  it("rejects a fractional slippage rather than rounding it", () => {
    expect(() => computeApprovedMinOut("1000", 0.5)).toThrow(RangeError);
  });

  it("rejects a non-integer raw amount rather than coercing it", () => {
    expect(() => computeApprovedMinOut("1.5", 50)).toThrow(TypeError);
  });
});
