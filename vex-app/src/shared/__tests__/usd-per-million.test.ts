/** Per-1M prices from provider per-token text: exact decimal shifts, never a float. */

import { describe, expect, it } from "vitest";
import { USD_DECIMAL_PATTERN, usdDecimalFromNumber, usdPerMillionFromPerToken } from "../usd-per-million.js";

describe("usdPerMillionFromPerToken", () => {
  it.each([
    ["0.00000014375", "0.14375"],
    ["0.000000575", "0.575"],
    ["0.0000115", "11.5"],
    ["0.000003", "3"],
    ["0", "0"],
    ["0.0000000004", "0.0004"],
    ["1", "1000000"],
    ["0.000000115", "0.115"],
  ])("%s per token is %s per 1M", (perToken, perMillion) => {
    expect(usdPerMillionFromPerToken(perToken)).toBe(perMillion);
  });

  it.each([["-1"], ["1e-7"], [""], ["abc"], [3], [null]])("states no price for %s", (raw) => {
    expect(usdPerMillionFromPerToken(raw)).toBeNull();
  });
});

describe("usdDecimalFromNumber", () => {
  it("keeps the published digits and drops the float noise", () => {
    // Claude Haiku 5.5's live prompt price: the float product is 0.11499999999999999.
    expect(Number("0.000000115") * 1_000_000).not.toBe(0.115);
    expect(usdDecimalFromNumber(Number("0.000000115") * 1_000_000)).toBe("0.115");
    expect(usdDecimalFromNumber(11.5)).toBe("11.5");
    expect(usdDecimalFromNumber(0)).toBe("0");
    expect(usdDecimalFromNumber(-1)).toBeNull();
    expect(usdDecimalFromNumber(Number.NaN)).toBeNull();
  });

  it("produces only the canonical text the schema accepts", () => {
    for (const text of ["0.14375", "0.575", "11.5", "0", "1000000"]) {
      expect(USD_DECIMAL_PATTERN.test(text)).toBe(true);
    }
  });
});
