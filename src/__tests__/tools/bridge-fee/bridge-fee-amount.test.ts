/**
 * Vex bridge integrator fee — the arithmetic contract.
 *
 * This is a REAL-FUNDS path: the number this module returns is transferred
 * on-chain and subtracted from what the venue is quoted for. Every case here
 * is a property that must hold exactly, in bigint, at u64 scale.
 */

import { describe, expect, it } from "vitest";

import { BRIDGE_FEE_BPS } from "@tools/bridge-fee/constants.js";
import { splitBridgeAmountForFee } from "@tools/bridge-fee/fee-amount.js";

describe("splitBridgeAmountForFee — fee = floor(amountIn × 25 / 10000)", () => {
  it("pins the product-owner rate at 25 bps", () => {
    // Guards against a silent constant edit: every expectation below is
    // derived from this number.
    expect(BRIDGE_FEE_BPS).toBe(25);
  });

  it("computes the exact floor for representative amounts", () => {
    const cases: ReadonlyArray<readonly [string, bigint]> = [
      ["1000000", 2500n], // 1 USDC (6dp)
      ["1500000", 3750n],
      ["15000000000000000", 37_500_000_000_000n], // 0.015 SOL at 18dp scale
      ["400", 1n], // the exact threshold where the fee stops flooring to 0
      ["399", 0n],
    ];
    for (const [amount, expectedFee] of cases) {
      const split = splitBridgeAmountForFee(amount);
      expect(split.feeRaw, `fee for ${amount}`).toBe(expectedFee);
      expect(split.totalRaw).toBe(BigInt(amount));
      // The invariant that makes the user's `amount` the TOTAL debited.
      expect(split.feeRaw + split.bridgedRaw).toBe(split.totalRaw);
    }
  });

  it("FLOORS rather than rounds — 25 bps of 15,000,000 SOL lamports keeps every remainder", () => {
    // 1_599 × 25 = 39_975 → /10000 = 3.9975 → floor 3. A rounding
    // implementation would return 4 and overcharge by 1 unit.
    expect(splitBridgeAmountForFee("1599").feeRaw).toBe(3n);
    expect(splitBridgeAmountForFee("799").feeRaw).toBe(1n);
  });

  it("is exact at u64 scale (no float, no precision loss)", () => {
    const u64Max = (2n ** 64n) - 1n; // 18_446_744_073_709_551_615
    const split = splitBridgeAmountForFee(u64Max.toString());
    expect(split.feeRaw).toBe((u64Max * 25n) / 10_000n);
    expect(split.feeRaw).toBe(46_116_860_184_273_879n);
    expect(split.bridgedRaw).toBe(u64Max - split.feeRaw);
    expect(split.feeRaw + split.bridgedRaw).toBe(u64Max);
    // The Number path would have collapsed this into a rounded double.
    expect(split.feeRaw).not.toBe(BigInt(Math.floor(Number(u64Max) * 0.0025)));
  });

  it("beyond u64 — a 30-decimal token amount stays exact", () => {
    const huge = 10n ** 36n + 7n;
    const split = splitBridgeAmountForFee(huge.toString());
    expect(split.feeRaw).toBe((huge * 25n) / 10_000n);
    expect(split.feeRaw + split.bridgedRaw).toBe(huge);
  });

  it("DUST: a fee that floors to 0 is not charged and the whole amount bridges", () => {
    for (const dust of ["1", "5", "100", "399"]) {
      const split = splitBridgeAmountForFee(dust);
      expect(split.feeRaw, `fee for ${dust}`).toBe(0n);
      // `charged:false` is what makes the caller SKIP the leg entirely — a
      // zero-value transfer would burn gas, add a row, and move nothing.
      expect(split.charged).toBe(false);
      expect(split.bridgedRaw).toBe(BigInt(dust));
    }
  });

  it("charges as soon as the fee reaches one smallest unit", () => {
    expect(splitBridgeAmountForFee("400").charged).toBe(true);
    expect(splitBridgeAmountForFee("399").charged).toBe(false);
  });

  it("accepts a bigint and 0x-hex amount identically to the decimal string", () => {
    expect(splitBridgeAmountForFee(1_000_000n).feeRaw).toBe(2500n);
    expect(splitBridgeAmountForFee("0xF4240").feeRaw).toBe(2500n); // 1_000_000
  });

  it("REFUSES a non-positive or unparseable amount rather than silently charging nothing", () => {
    for (const bad of ["0", "-1", "", "  ", "1.5", "1e6", "abc", "0x"]) {
      expect(() => splitBridgeAmountForFee(bad), `amount ${JSON.stringify(bad)}`).toThrow();
    }
    expect(() => splitBridgeAmountForFee(0n)).toThrow();
    expect(() => splitBridgeAmountForFee(-5n)).toThrow();
  });
});
