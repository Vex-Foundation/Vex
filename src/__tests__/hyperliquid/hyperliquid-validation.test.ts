import { describe, expect, it } from "vitest";
import {
  assertMinimumNotional,
  assertValidLeverage,
  assertValidPerpPrice,
  assertValidPerpSize,
  assertValidSpotPrice,
  marketOrderPrice,
  parseDecimalString,
  roundSizeDown,
} from "@tools/hyperliquid/validation.js";

describe("Hyperliquid financial validation", () => {
  it("enforces tick precision and five significant figures", () => {
    expect(() => assertValidPerpPrice(parseDecimalString("1234.5"), 2)).not.toThrow();
    expect(() => assertValidPerpPrice(parseDecimalString("1234.56"), 2)).toThrow(/five significant/i);
    expect(() => assertValidPerpPrice(parseDecimalString("1.2345"), 2)).not.toThrow();
    expect(() => assertValidPerpPrice(parseDecimalString("1.23456"), 2)).toThrow(/at most 4/i);
    expect(() => assertValidPerpPrice(parseDecimalString("123456"), 2)).not.toThrow();
  });

  it("enforces asset size precision and rounds down exact decimals", () => {
    expect(() => assertValidPerpSize(parseDecimalString("1.23"), 2)).not.toThrow();
    expect(() => assertValidPerpSize(parseDecimalString("1.234"), 2)).toThrow(/at most 2/i);
    expect(roundSizeDown(parseDecimalString("1.239"), 2)).toBe("1.23");
  });

  it("uses spot MAX_DECIMALS=8 precision", () => {
    expect(() => assertValidSpotPrice(parseDecimalString("1.2345"), 3)).not.toThrow();
    expect(() => assertValidSpotPrice(parseDecimalString("0.0000012345"), 3)).toThrow(/at most 5/i);
  });

  it("enforces the $10 minimum except reduce-only closes", () => {
    expect(() => assertMinimumNotional(parseDecimalString("10"), parseDecimalString("1"), false)).not.toThrow();
    expect(() => assertMinimumNotional(parseDecimalString("9"), parseDecimalString("1"), false)).toThrow(/at least \$10/i);
    expect(() => assertMinimumNotional(parseDecimalString("9"), parseDecimalString("1"), true)).not.toThrow();
  });

  it("bounds leverage to the asset maximum", () => {
    expect(() => assertValidLeverage(5, 5)).not.toThrow();
    expect(() => assertValidLeverage(0, 5)).toThrow();
    expect(() => assertValidLeverage(6, 5)).toThrow();
    expect(() => assertValidLeverage(1.5, 5)).toThrow();
  });

  it("rejects noncanonical financial decimal strings", () => {
    for (const value of ["1.50", "1e2", "-0"]) {
      expect(() => parseDecimalString(value)).toThrow();
    }
  });

  it("computes IOC slippage caps with exact decimals", () => {
    expect(marketOrderPrice(parseDecimalString("100"), "buy", 125)).toBe("101.25");
    expect(marketOrderPrice(parseDecimalString("100"), "sell", 125)).toBe("98.75");
  });

  it.each([0, 1, 2, 3, 5])("formats derived IOC caps to a valid perp tick at szDecimals=%i", (szDecimals) => {
    const marks = szDecimals === 5
      ? ["1.234567", "123.4567", "98765.4321"]
      : ["0.1", "1.234567", "123.4567", "98765.4321"];
    for (const mark of marks) {
      for (const side of ["buy", "sell"] as const) {
        const cap = marketOrderPrice(parseDecimalString(mark), side, 37, szDecimals);
        expect(() => assertValidPerpPrice(cap, szDecimals)).not.toThrow();
      }
    }
  });
});
