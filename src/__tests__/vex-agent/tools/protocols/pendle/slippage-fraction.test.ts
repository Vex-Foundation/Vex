/**
 * `slippageFraction` must REJECT an invalid basis-point tolerance, not quietly
 * substitute a default for it.
 *
 * DEFECT: the previous implementation was
 *   `const b = bps !== undefined && bps >= 0 ? bps : DEFAULT_SLIPPAGE_BPS;`
 * so `slippageFraction(-1)` returned the 50 bps DEFAULT. A negative is not a
 * tolerance — it is a caller error, and trading with a tolerance the caller
 * never asked for hides that error at a price-protection boundary. The same
 * expression accepted a fractional value untouched.
 *
 * The `Math.min(bps, 5000)` cap is PRE-EXISTING and deliberately unchanged
 * here; it belongs to a separate, owner-gated decision. These tests pin it as
 * current behaviour so a later change to it is a visible, intentional diff.
 */

import { describe, it, expect } from "vitest";

import { VexError, ErrorCodes } from "../../../../../errors.js";
import {
  slippageFraction,
  DEFAULT_SLIPPAGE_BPS,
} from "@vex-agent/tools/protocols/pendle/handlers/shared.js";

describe("slippageFraction rejects invalid basis points", () => {
  it("rejects -1 instead of returning the 50 bps default", () => {
    // The exact regression: the old code answered -1 with DEFAULT_SLIPPAGE_BPS,
    // i.e. this call RETURNED 0.005 instead of throwing.
    expect(() => slippageFraction(-1)).toThrow(/slippageBps/i);
  });

  it("the -1 rejection explains the rule rather than defaulting", () => {
    // `VexError` carries the actionable guidance on `.hint`, not in `.message`.
    let caught: unknown;
    try {
      slippageFraction(-1);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(VexError);
    expect((caught as VexError).code).toBe(ErrorCodes.INVALID_AMOUNT);
    expect((caught as VexError).hint).toMatch(/whole, non-negative/i);
  });

  for (const value of [0.5, 50.5, 50.9]) {
    it(`rejects the fractional value ${value}`, () => {
      expect(() => slippageFraction(value)).toThrow(/slippageBps/i);
    });
  }

  it("rejects a non-finite value", () => {
    expect(() => slippageFraction(Number.NaN)).toThrow(/slippageBps/i);
    expect(() => slippageFraction(Number.POSITIVE_INFINITY)).toThrow(/slippageBps/i);
  });
});

describe("slippageFraction preserves valid behaviour", () => {
  it("an omitted value still takes the documented default", () => {
    expect(slippageFraction(undefined)).toBe(DEFAULT_SLIPPAGE_BPS / 10_000);
  });

  it.each([
    [0, 0],
    [1, 0.0001],
    [50, 0.005],
    [100, 0.01],
    [250, 0.025],
    [5000, 0.5],
  ])("converts %i bps to the fraction %f", (bps, expected) => {
    expect(slippageFraction(bps)).toBeCloseTo(expected, 10);
  });

  it("keeps the pre-existing 5000 bps cap unchanged (separate card owns it)", () => {
    expect(slippageFraction(9000)).toBe(0.5);
    expect(slippageFraction(10_000)).toBe(0.5);
  });
});
