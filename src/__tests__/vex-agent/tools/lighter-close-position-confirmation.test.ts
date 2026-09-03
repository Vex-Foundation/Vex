import { describe, expect, it } from "vitest";
import { confirmedLighterCloseDisposition } from "@vex-agent/tools/protocols/lighter/close-position-confirmation.js";

describe("Lighter close position confirmation", () => {
  it.each([
    { filled: "0.0983", remaining: "0", sign: 1, expected: "closed" },
    { filled: "0.0983", remaining: "0.0983", sign: 1, expected: null },
    { filled: "0.0400", remaining: "0.0583", sign: 1, expected: "partially_closed" },
    { filled: "0.0400", remaining: "0", sign: 1, expected: null },
    { filled: "0.0400", remaining: "0.0583", sign: -1, expected: null },
    { filled: "0", remaining: "0.0983", sign: 1, expected: "not_closed" },
    { filled: "0.0984", remaining: "0", sign: 1, expected: null },
    { filled: "invalid", remaining: "0", sign: 1, expected: null },
  ])("checks fill $filled against remaining position $remaining", ({ filled, remaining, sign, expected }) => {
    expect(confirmedLighterCloseDisposition({
      initialPosition: "0.0983", initialSign: 1, filledAmount: filled,
      resultingPosition: remaining, resultingSign: sign, sizeDecimals: 4,
    })).toBe(expected);
  });

  it("confirms a short reduction at BTC precision without floating point rounding", () => {
    expect(confirmedLighterCloseDisposition({
      initialPosition: "0.00015", initialSign: -1, filledAmount: "0.00010",
      resultingPosition: "0.00005", resultingSign: -1, sizeDecimals: 5,
    })).toBe("partially_closed");
  });
});
