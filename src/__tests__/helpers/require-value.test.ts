import { describe, expect, it } from "vitest";
import { requireValue } from "./require-value.js";

describe("requireValue", () => {
  it("rejects absent values without rejecting defined falsy values", () => {
    expect(() => requireValue(null)).toThrow("Expected a defined test value");
    expect(() => requireValue(undefined)).toThrow("Expected a defined test value");
    for (const value of [0, false, ""]) expect(requireValue(value)).toBe(value);
  });
});
