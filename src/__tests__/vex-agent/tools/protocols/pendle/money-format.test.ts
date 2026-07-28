/**
 * Pendle read-output money formatting.
 *
 * The precision cases here are the point. The projectors this replaces did
 * `Number(balanceWei) / 10 ** decimals`, which stops being exact above 2^53 —
 * about 9 tokens at 18 decimals. Every real Pendle LP balance is past that line.
 */

import { describe, expect, it } from "vitest";

import {
  amountTriplet,
  bpsString,
  daysUntil,
  formatBaseUnits,
  percentString,
  sumUsdStrings,
  usdString,
} from "@vex-agent/tools/protocols/pendle/money-format.js";

describe("formatBaseUnits", () => {
  it("is EXACT where Number() is not", () => {
    // Live wallet B's LP balance. Number() renders 13.784740827710357 — the last
    // three base units are gone before the string is ever built.
    const raw = "13784740827710356437";
    expect(formatBaseUnits(raw, 18)).toBe("13.784740827710356437");
    expect(String(Number(raw) / 1e18)).not.toBe("13.784740827710356437");
  });

  it("handles the decimals that actually differ across Pendle assets", () => {
    expect(formatBaseUnits("1047061", 6)).toBe("1.047061");
    expect(formatBaseUnits("1047061", 9)).toBe("0.001047061");
    expect(formatBaseUnits("428049761343350871", 18)).toBe("0.428049761343350871");
    expect(formatBaseUnits("19892543", 6)).toBe("19.892543");
  });

  it("trims trailing fractional zeros but never significant digits", () => {
    expect(formatBaseUnits("1500000", 6)).toBe("1.5");
    expect(formatBaseUnits("1000000", 6)).toBe("1");
    expect(formatBaseUnits("0", 18)).toBe("0");
    expect(formatBaseUnits("1", 18)).toBe("0.000000000000000001");
  });

  it("supports 0 decimals", () => {
    expect(formatBaseUnits("4200", 0)).toBe("4200");
  });

  it("refuses anything that is not base units, rather than coercing", () => {
    expect(formatBaseUnits("1.5", 18)).toBeNull();
    expect(formatBaseUnits("-1", 18)).toBeNull();
    expect(formatBaseUnits("1e18", 18)).toBeNull();
    expect(formatBaseUnits("", 18)).toBeNull();
    expect(formatBaseUnits("1", -1)).toBeNull();
    expect(formatBaseUnits("1", 37)).toBeNull();
    expect(formatBaseUnits("1", 1.5)).toBeNull();
  });
});

describe("amountTriplet", () => {
  it("carries raw, decimals and the exact string together", () => {
    expect(amountTriplet("1056635259419805288", 18)).toEqual({
      raw: "1056635259419805288",
      decimals: 18,
      exact: "1.056635259419805288",
    });
  });

  it("reports UNKNOWN decimals as a null exact — never an assumed 18", () => {
    expect(amountTriplet("1047061", null)).toEqual({ raw: "1047061", decimals: null, exact: null });
  });
});

describe("usdString", () => {
  it("renders a provider float as a decimal string with at least two places", () => {
    expect(usdString(33.16977270484528)).toBe("33.169773");
    expect(usdString(1)).toBe("1.00");
    expect(usdString(0)).toBe("0.00");
    expect(usdString(1.5)).toBe("1.50");
  });

  it("returns null rather than NaN for an unusable value", () => {
    expect(usdString(null)).toBeNull();
    expect(usdString(undefined)).toBeNull();
    expect(usdString(Number.NaN)).toBeNull();
    expect(usdString(Number.POSITIVE_INFINITY)).toBeNull();
    expect(usdString(1e15)).toBeNull();
  });
});

describe("sumUsdStrings", () => {
  it("sums exactly where repeated float addition drifts", () => {
    const tenth = usdString(0.1)!;
    const { total } = sumUsdStrings(Array.from({ length: 3 }, () => tenth));
    expect(total).toBe("0.30");
    // The float path this replaces: 0.1 + 0.1 + 0.1 === 0.30000000000000004.
    expect(String(0.1 + 0.1 + 0.1)).not.toBe("0.3");
  });

  it("adds the live wallet's valuations", () => {
    const values = [1.0198843562633857, 5.059808449406191, 1.9159132430304648, 1.9550298791074934].map(usdString);
    // 1.019884 + 5.059808 + 1.915913 + 1.955030, each already rounded to the
    // micro-dollar scale before summing — the sum is of the STRINGS we publish,
    // so a reader can add the rows up and get the same total we printed.
    expect(sumUsdStrings(values)).toEqual({ total: "9.950635", counted: 4, skipped: 0 });
  });

  it("SKIPS an unpriceable position instead of absorbing it as zero", () => {
    const result = sumUsdStrings([usdString(10), null, usdString(5)]);
    expect(result).toEqual({ total: "15.00", counted: 2, skipped: 1 });
  });

  it("handles an empty set", () => {
    expect(sumUsdStrings([])).toEqual({ total: "0.00", counted: 0, skipped: 0 });
  });
});

describe("percentString / bpsString", () => {
  it("converts Pendle's decimal fractions to the unit the field name promises", () => {
    // Live: impliedApy 0.02276412113952293 is 2.28%, not 0.02%.
    expect(percentString(0.02276412113952293)).toBe("2.28");
    expect(percentString(0.2473)).toBe("24.73");
    expect(percentString(-1)).toBe("-100.00");
    expect(bpsString(0.0009147076236166729)).toBe("9.15");
  });

  it("returns null for an unusable rate", () => {
    expect(percentString(null)).toBeNull();
    expect(percentString(Number.NaN)).toBeNull();
    expect(bpsString(undefined)).toBeNull();
  });
});

describe("daysUntil", () => {
  const NOW = Date.parse("2026-07-27T00:00:00.000Z");

  it("is positive before expiry and negative after", () => {
    expect(daysUntil("2027-12-30T00:00:00.000Z", NOW)).toBe(521);
    expect(daysUntil("2026-04-02T00:00:00.000Z", NOW)).toBe(-116);
    expect(daysUntil("2026-07-27T00:00:00.000Z", NOW)).toBe(0);
  });

  it("returns null for an unreadable expiry", () => {
    expect(daysUntil(null, NOW)).toBeNull();
    expect(daysUntil("not-a-date", NOW)).toBeNull();
  });
});
