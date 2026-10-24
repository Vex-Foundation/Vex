import { describe, expect, it } from "vitest";

import {
  alertFires,
  alertLevel,
  alreadyPast,
  formatAlertDecimal,
  parseAlertValue,
} from "@vex-agent/alerts/condition.js";
import {
  multiplyBoundedDecimals,
  parseBoundedDecimal,
  type BoundedDecimal,
} from "../../../tools/dexscreener/token-watch-price/decimal.js";

function dec(raw: string): BoundedDecimal {
  const parsed = parseBoundedDecimal(raw);
  if (parsed === null) throw new Error(`not a decimal: ${raw}`);
  return parsed;
}

function level(condition: Parameters<typeof alertLevel>[0], value: string, reference: string): string {
  const out = alertLevel(condition, dec(value), dec(reference));
  if (out === null) throw new Error("no level");
  return `${out.direction} ${formatAlertDecimal(out.triggerPrice)}`;
}

describe("multiplyBoundedDecimals", () => {
  it("multiplies exactly, scales added", () => {
    expect(formatAlertDecimal(multiplyBoundedDecimals(dec("1.5"), dec("2.25")))).toBe("3.375");
    expect(formatAlertDecimal(multiplyBoundedDecimals(dec("0.000001"), dec("1000000")))).toBe("1");
    expect(formatAlertDecimal(multiplyBoundedDecimals(dec("0"), dec("123.4")))).toBe("0");
  });
});

describe("parseAlertValue", () => {
  it("accepts plain positive decimals within the digit bounds", () => {
    expect(parseAlertValue("above", "250")).not.toBeNull();
    expect(parseAlertValue("above", " 0.000000012345 ")).not.toBeNull();
    expect(parseAlertValue("rises_pct", "1000")).not.toBeNull();
    expect(parseAlertValue("falls_pct", "99.999")).not.toBeNull();
  });

  it("refuses zero, signs, exponents, too many digits and words", () => {
    for (const raw of ["0", "0.0", "-1", "1e5", "1,000", "abc", "", "1234567890123456", "1.1234567890123"]) {
      expect(parseAlertValue("above", raw)).toBeNull();
    }
  });

  it("refuses a move above 1000% and a fall of 100% or more", () => {
    expect(parseAlertValue("rises_pct", "1000.01")).toBeNull();
    expect(parseAlertValue("falls_pct", "100")).toBeNull();
    expect(parseAlertValue("falls_pct", "150")).toBeNull();
  });
});

describe("alertLevel", () => {
  it("keeps a level alert's value as its level", () => {
    expect(level("above", "4000", "3500")).toBe("above 4000");
    expect(level("below", "3000", "3500")).toBe("below 3000");
  });

  it("turns a percentage into an absolute level, exactly", () => {
    expect(level("rises_pct", "10", "200")).toBe("above 220");
    expect(level("falls_pct", "10", "200")).toBe("below 180");
    expect(level("rises_pct", "0.1", "2386.55")).toBe("above 2388.93655");
    expect(level("falls_pct", "12.5", "0.00000804")).toBe("below 0.000007035");
  });

  it("truncates a non-terminating level at 20 digits, never rounds", () => {
    expect(level("rises_pct", "1", "0.00000000000000000003")).toBe("above 0.00000000000000000003");
  });
});

describe("alertFires and alreadyPast", () => {
  it("fires on touching the level, on its own side only", () => {
    expect(alertFires(dec("4000"), dec("4000"), "above")).toBe(true);
    expect(alertFires(dec("3999.99"), dec("4000"), "above")).toBe(false);
    expect(alertFires(dec("3000"), dec("3000"), "below")).toBe(true);
    expect(alertFires(dec("3000.01"), dec("3000"), "below")).toBe(false);
  });

  it("calls a level alert already past when the price is on or beyond it", () => {
    expect(alreadyPast("above", dec("4000"), dec("4000"))).toBe(true);
    expect(alreadyPast("above", dec("4000"), dec("3999"))).toBe(false);
    expect(alreadyPast("below", dec("3000"), dec("2999"))).toBe(true);
  });

  it("never calls a move already past: it is measured from now", () => {
    expect(alreadyPast("rises_pct", dec("1"), dec("999999"))).toBe(false);
    expect(alreadyPast("falls_pct", dec("1"), dec("0.0001"))).toBe(false);
  });
});
