/** Integer formatting of Vex Cloud figures: rounded down, never invented. */

import { describe, expect, it } from "vitest";
import { formatRateAge, formatTokenCount, formatUsdEstimate, formatVexAmount } from "../vex-cloud-format.js";

const vex = (wei: string) => ({ wei, decimals: 18 as const, symbol: "VEX" as const, usdMicroEstimate: null });

describe("formatVexAmount", () => {
  it.each([
    ["0", "0.00 VEX"],
    ["1000000000000000000000", "1,000.00 VEX"],
    ["1234567891234567891234", "1,234.56 VEX"],
    // Rounded DOWN: 0.019999... is 0.01, never 0.02.
    ["19999999999999999", "0.01 VEX"],
    ["9999999999999999", "less than 0.01 VEX"],
    ["1", "less than 0.01 VEX"],
    ["123456789000000000000000000", "123,456,789.00 VEX"],
  ])("%s wei -> %s", (wei, expected) => {
    expect(formatVexAmount(vex(wei))).toBe(expected);
  });
});

describe("formatUsdEstimate", () => {
  it.each([
    [null, null],
    ["0", "$0.00"],
    ["1234567", "$1.23"],
    ["1239999", "$1.23"],
    ["9999", "less than $0.01"],
    ["1000000000000", "$1,000,000.00"],
  ])("%s micro-USD -> %s", (micro, expected) => {
    expect(formatUsdEstimate(micro)).toBe(expected);
  });
});

describe("formatRateAge", () => {
  it("says how old the rate is, or nothing without one", () => {
    const at = {
      available: true as const,
      source: "fixed",
      observedAt: "2026-10-20T12:00:00.000Z",
      vexWeiPerMicroUsd: "1000000000000000",
      validUntil: "2026-10-20T12:05:00.000Z",
    };
    expect(formatRateAge({ ...at, ageSeconds: 42 })).toBe("rate 42 s old");
    expect(formatRateAge({ ...at, ageSeconds: 125 })).toBe("rate 2 min old");
    expect(formatRateAge({ ...at, ageSeconds: 7_300 })).toBe("rate 2 h old");
    expect(formatRateAge({ available: false, reason: "stale" })).toBeNull();
  });
});

describe("formatTokenCount", () => {
  it("groups thousands", () => {
    expect(formatTokenCount(65_536)).toBe("65,536");
  });
});
