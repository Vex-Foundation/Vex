/**
 * The ONE bps-split owner every Vex integrator fee is computed by.
 *
 * REAL FUNDS. Before this module there were four independent copies of
 * `(x * 25n) / 10_000n` (bridge, KyberSwap, Jupiter, the KyberSwap source-
 * transfer binding). The arithmetic is now stated once, so a rounding or
 * denominator mistake cannot exist at one venue and not another.
 */

import { describe, expect, it } from "vitest";

import { splitAmountForFeeBps } from "@tools/vex-fee/bps-split.js";

const BPS_25 = { bps: 25 } as const;

describe("splitAmountForFeeBps — fee = floor(amount × bps / 10000)", () => {
  it("computes the exact floor and keeps fee + net === total", () => {
    const cases: ReadonlyArray<readonly [string, bigint]> = [
      ["1000000", 2500n],
      ["1500000", 3750n],
      ["15000000000000000", 37_500_000_000_000n],
      ["400", 1n],
      ["399", 0n],
    ];
    for (const [amount, expectedFee] of cases) {
      const split = splitAmountForFeeBps(amount, BPS_25);
      expect(split.feeRaw, `fee for ${amount}`).toBe(expectedFee);
      expect(split.totalRaw).toBe(BigInt(amount));
      expect(split.feeRaw + split.netRaw).toBe(split.totalRaw);
    }
  });

  it("FLOORS rather than rounds — a remainder is never rounded UP into an overcharge", () => {
    expect(splitAmountForFeeBps("1599", BPS_25).feeRaw).toBe(3n);
    expect(splitAmountForFeeBps("799", BPS_25).feeRaw).toBe(1n);
  });

  it("is exact past u64 — no float anywhere on the path", () => {
    const u64Max = 2n ** 64n - 1n;
    const split = splitAmountForFeeBps(u64Max, BPS_25);
    expect(split.feeRaw).toBe(46_116_860_184_273_879n);
    expect(split.feeRaw).not.toBe(BigInt(Math.floor(Number(u64Max) * 0.0025)));

    const huge = 10n ** 36n + 7n;
    const hugeSplit = splitAmountForFeeBps(huge, BPS_25);
    expect(hugeSplit.feeRaw).toBe((huge * 25n) / 10_000n);
    expect(hugeSplit.feeRaw + hugeSplit.netRaw).toBe(huge);
  });

  it("DUST: a fee that floors to 0 reports charged:false and leaves the amount whole", () => {
    for (const dust of ["1", "5", "100", "399"]) {
      const split = splitAmountForFeeBps(dust, BPS_25);
      expect(split.feeRaw, `fee for ${dust}`).toBe(0n);
      expect(split.charged).toBe(false);
      expect(split.netRaw).toBe(BigInt(dust));
    }
    expect(splitAmountForFeeBps("400", BPS_25).charged).toBe(true);
  });

  it("accepts bigint and 0x-hex identically to a decimal string", () => {
    expect(splitAmountForFeeBps(1_000_000n, BPS_25).feeRaw).toBe(2500n);
    expect(splitAmountForFeeBps("0xF4240", BPS_25).feeRaw).toBe(2500n);
  });

  it("REFUSES a non-positive or unparseable amount rather than silently charging nothing", () => {
    for (const bad of ["0", "-1", "", "  ", "1.5", "1e6", "abc", "0x"]) {
      expect(() => splitAmountForFeeBps(bad, BPS_25), `amount ${JSON.stringify(bad)}`).toThrow();
    }
    expect(() => splitAmountForFeeBps(0n, BPS_25)).toThrow();
    expect(() => splitAmountForFeeBps(-5n, BPS_25)).toThrow();
  });

  it("REFUSES a rate that is not a whole number of basis points in [0, 10000]", () => {
    for (const bps of [-1, 0.5, 10_001, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => splitAmountForFeeBps("1000000", { bps }), `bps ${bps}`).toThrow();
    }
  });

  it("names the caller's amount in the refusal so a venue error is diagnosable", () => {
    expect(() => splitAmountForFeeBps("0", { bps: 25, amountLabel: "Bridge amount" }))
      .toThrow(/Bridge amount/);
  });

  it("a 0 bps rate is a lawful no-fee split, not a refusal", () => {
    const split = splitAmountForFeeBps("1000000", { bps: 0 });
    expect(split.feeRaw).toBe(0n);
    expect(split.charged).toBe(false);
    expect(split.netRaw).toBe(1_000_000n);
  });
});
