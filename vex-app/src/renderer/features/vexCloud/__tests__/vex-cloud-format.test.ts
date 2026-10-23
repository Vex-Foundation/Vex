/** Integer formatting of Vex Cloud figures: rounded down, never invented. */

import { describe, expect, it } from "vitest";
import {
  formatRateAge,
  formatTokenCount,
  formatUsdPerVex,
  formatVexAmount,
  formatVexWei,
  usdEstimateOf,
} from "../vex-cloud-format.js";

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

describe("formatVexWei", () => {
  it.each([
    // The release capture's withdrawable balance: two decimals, rounded down.
    ["998822910592527374555", "998.82 VEX"],
    ["0", "0.00 VEX"],
    ["1", "less than 0.01 VEX"],
    ["6000123456789012345678", "6,000.12 VEX"],
  ])("%s wei -> %s", (wei, expected) => {
    expect(formatVexWei(wei)).toBe(expected);
    expect(formatVexWei(BigInt(wei))).toBe(expected);
  });
});

describe("usdEstimateOf", () => {
  it.each([
    [null, null],
    ["0", { qualifier: null, figure: "$0.00" }],
    ["1234567", { qualifier: "about", figure: "$1.23" }],
    ["1239999", { qualifier: "about", figure: "$1.23" }],
    // Under a cent is "less than", never "about less than".
    ["9999", { qualifier: "less than", figure: "$0.01" }],
    ["1", { qualifier: "less than", figure: "$0.01" }],
    ["10000", { qualifier: "about", figure: "$0.01" }],
    ["1000000000000", { qualifier: "about", figure: "$1,000,000.00" }],
  ])("%s micro-USD -> %j", (micro, expected) => {
    expect(usdEstimateOf(micro)).toEqual(expected);
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

describe("formatUsdPerVex", () => {
  const at = {
    available: true as const,
    source: "twap",
    observedAt: "2026-10-20T12:00:00.000Z",
    ageSeconds: 60,
    validUntil: "2026-10-20T12:05:00.000Z",
  };
  it.each([
    // 10^15 wei per micro-USD: 1 VEX is 1,000 micro-USD.
    ["1000000000000000", "$0.001"],
    // 1 VEX = $0.0018 as the backend formats it (18 fractional digits, truncated).
    ["555555555555555.555555555555555555", "$0.0018"],
    // Four significant digits, rounded DOWN: never above the backend's rate.
    ["543478260869565.217391304347826086", "$0.00184"],
    ["1000000000000", "$1"],
    ["999999999999", "$1"],
  ])("%s wei per micro-USD -> %s per VEX", (rate, expected) => {
    expect(formatUsdPerVex({ ...at, vexWeiPerMicroUsd: rate })).toBe(expected);
  });

  it("claims nothing without a rate", () => {
    expect(formatUsdPerVex({ available: false, reason: "stale" })).toBeNull();
  });
});

describe("formatTokenCount", () => {
  it("groups thousands", () => {
    expect(formatTokenCount(65_536)).toBe("65,536");
  });
});
