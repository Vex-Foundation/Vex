import { describe, expect, it } from "vitest";
import {
  formatCompactCount,
  formatPercentDelta,
  formatTokenPriceUsd,
} from "../format.js";

describe("formatTokenPriceUsd", () => {
  it("keeps ~4 significant figures for a sub-cent token (not $0.00)", () => {
    // The core reason this exists: formatUsd would collapse VEX to $0.00.
    expect(formatTokenPriceUsd(0.000543)).toBe("$0.0005430");
  });

  it("uses 2 decimals at/above $1 and 4 decimals in the cent range", () => {
    expect(formatTokenPriceUsd(1.5)).toBe("$1.50");
    expect(formatTokenPriceUsd(12.3456)).toBe("$12.35");
    expect(formatTokenPriceUsd(0.0532)).toBe("$0.0532");
  });

  it("renders exact zero and an em dash for null/non-finite", () => {
    expect(formatTokenPriceUsd(0)).toBe("$0.00");
    expect(formatTokenPriceUsd(null)).toBe("-");
    expect(formatTokenPriceUsd(Number.NaN)).toBe("-");
    expect(formatTokenPriceUsd(Number.POSITIVE_INFINITY)).toBe("-");
  });
});

describe("formatPercentDelta", () => {
  it("signs the change and fixes 2 decimals", () => {
    expect(formatPercentDelta(113)).toBe("+113.00%");
    expect(formatPercentDelta(-1.73)).toBe("-1.73%");
    expect(formatPercentDelta(0)).toBe("0.00%");
  });

  it("returns an em dash for null/non-finite", () => {
    expect(formatPercentDelta(null)).toBe("-");
    expect(formatPercentDelta(Number.NaN)).toBe("-");
  });
});

describe("formatCompactCount", () => {
  it("compacts thousands / millions and passes small integers through", () => {
    expect(formatCompactCount(354)).toBe("354");
    expect(formatCompactCount(1234)).toBe("1.2K");
    expect(formatCompactCount(3_400_000)).toBe("3.4M");
  });

  it("returns an em dash for null/non-finite", () => {
    expect(formatCompactCount(null)).toBe("-");
    expect(formatCompactCount(Number.NaN)).toBe("-");
  });
});
