/**
 * `computeKyberVexFeeRaw` — the exact Vex integrator fee a KyberSwap swap takes.
 *
 * This number becomes a durable financial record (`agent_activity.
 * vex_fee_amount_raw`, migration 050 Part 2), so the load-bearing test is not
 * that the arithmetic is self-consistent — it is that the arithmetic matches
 * what the ROUTER actually does. That is pinned against REAL captured
 * `/route/build` bytes: the decoded description says how much the user spends
 * (`desc.amount`) and how much is handed to the pools (`srcAmounts`), and the
 * difference is the fee the router keeps. If KyberSwap ever changes its fee
 * arithmetic, re-capturing the fixture fails this test rather than silently
 * writing a wrong number into the ledger.
 */

import { describe, it, expect } from "vitest";
import { decodeFunctionData, type Hex } from "viem";

import { computeKyberVexFeeRaw } from "@tools/kyberswap/swap-vex-fee.js";
import { KYBERSWAP_FEE_BPS } from "@tools/kyberswap/constants.js";
import { META_AGGREGATION_ROUTER_V2_SWAP_ABI } from "@tools/kyberswap/evm/swap-calldata-guard.js";

import capture from "./fixtures/route-build/base-usdc-to-native-50bps.json" with { type: "json" };

/** The fee the captured router call actually keeps: what is spent minus what reaches the pools. */
function feeKeptByCapturedRouterCall(): { amount: bigint; feeKept: bigint } {
  const decoded = decodeFunctionData({
    abi: META_AGGREGATION_ROUTER_V2_SWAP_ABI,
    data: capture.build.data as Hex,
  });
  const execution = decoded.args[0] as unknown as Record<string, unknown>;
  const desc = execution.desc as Record<string, unknown>;
  const amount = desc.amount as bigint;
  const srcAmounts = desc.srcAmounts as readonly bigint[];
  const toPools = srcAmounts.reduce((total, part) => total + part, 0n);
  return { amount, feeKept: amount - toPools };
}

describe("computeKyberVexFeeRaw", () => {
  it("matches the fee the REAL captured router call keeps", () => {
    const { amount, feeKept } = feeKeptByCapturedRouterCall();

    // Guard the fixture itself: a capture that stopped carrying a fee line
    // would make the comparison below vacuously true.
    expect(feeKept).toBeGreaterThan(0n);
    expect(computeKyberVexFeeRaw(amount)).toBe(feeKept);
  });

  it("charges exactly KYBERSWAP_FEE_BPS of the input", () => {
    // 10 USDC at 6 decimals; 25 bps of it is 0.025 USDC.
    expect(computeKyberVexFeeRaw(10_000_000n)).toBe(25_000n);
    expect(computeKyberVexFeeRaw(10_000_000n)).toBe((10_000_000n * BigInt(KYBERSWAP_FEE_BPS)) / 10_000n);
  });

  it("TRUNCATES rather than rounds — the router's integer division, measured live", () => {
    // 10000300 * 25 / 10000 = 25000.75. A live probe (base, 2026-07-25) routed
    // 9975300 of 10000300, i.e. the router kept 25000, not 25001.
    expect(computeKyberVexFeeRaw(10_000_300n)).toBe(25_000n);
  });

  it("never invents a fee out of dust that rounds to nothing", () => {
    // 399 * 25 / 10000 = 0.9975 → the router keeps nothing.
    expect(computeKyberVexFeeRaw(399n)).toBe(0n);
    expect(computeKyberVexFeeRaw(0n)).toBe(0n);
    // 400 is the first input that yields a whole unit.
    expect(computeKyberVexFeeRaw(400n)).toBe(1n);
  });

  it("stays digit-exact at u64 scale, where a float would have lost the tail", () => {
    // Just under 2^64 — the largest realistic uint256 amount for an 18-decimal
    // token, and far beyond Number.MAX_SAFE_INTEGER.
    const amountIn = 18_446_744_073_709_551_615n;
    const fee = computeKyberVexFeeRaw(amountIn);

    expect(fee).toBe(46_116_860_184_273_879n);
    // The record stores digits, so prove the string form survives intact.
    expect(fee.toString()).toBe("46116860184273879");
    expect(BigInt(fee.toString())).toBe(fee);
    // The same computation in double precision silently corrupts the tail —
    // this is why the column is TEXT and the math is bigint.
    expect(String(Math.floor((Number(amountIn) * KYBERSWAP_FEE_BPS) / 10_000))).not.toBe(fee.toString());
  });

  it("refuses a negative amount instead of producing a fee for it", () => {
    expect(() => computeKyberVexFeeRaw(-1n)).toThrow(RangeError);
  });
});
