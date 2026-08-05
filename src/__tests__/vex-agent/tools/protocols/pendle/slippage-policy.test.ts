/**
 * Pendle's slippage tolerance must obey the VEX-WIDE policy: REJECTED, never
 * clamped (G-40 / P1-4, owner decision Q8).
 *
 * DEFECT 1 (closed earlier): the original expression was
 *   `const b = bps !== undefined && bps >= 0 ? bps : <the default>;`
 * so `-1` returned the 50 bps DEFAULT — trading with a tolerance the caller
 * never asked for, at a price-protection boundary.
 *
 * DEFECT 2 (closed by R5a): Pendle was the ONLY venue exempt from the global
 * ceiling. `handlers/shared.ts` clamped with `Math.min(bps, 5000)` while
 * `protocols/slippage-policy.ts` has pinned `VEX_MAX_SLIPPAGE_BPS = 1000`
 * "REJECTED, never clamped" for every other venue, and no Pendle file imported
 * it. `slippageBps: 999999` therefore clamped to 5000 on BOTH the quote and the
 * execute — so the prequote digests still collided and the trade executed at
 * 50% tolerance with nothing surfaced to the agent. Composed with the missing
 * price floor (P0-3), the realised loss was bounded by nothing we checked.
 *
 * Pendle now runs the same `checkSlippageBps` every other venue does, and the
 * resolver returns the BPS as well as the fraction, because the bps integer is
 * what the price floor is computed from.
 */

import { describe, it, expect } from "vitest";

import { VexError, ErrorCodes } from "../../../../../errors.js";
import { VEX_DEFAULT_SLIPPAGE_BPS, VEX_MAX_SLIPPAGE_BPS } from "@vex-agent/tools/protocols/slippage-policy.js";
import {
  resolvePendleSlippage,
} from "@vex-agent/tools/protocols/pendle/handlers/shared.js";

const TOOL = "pendle.pt.buy";

describe("Pendle obeys the Vex slippage ceiling — rejected, never clamped", () => {
  it("REFUSES 999999 bps instead of executing at 50% tolerance", () => {
    // The exact regression: this used to return 0.5 (5000 bps) and trade.
    expect(() => resolvePendleSlippage(TOOL, 999_999)).toThrow(/slippageBps/i);
  });

  it("refuses the old 5000 bps clamp target, which is above the Vex ceiling", () => {
    expect(() => resolvePendleSlippage(TOOL, 5000)).toThrow(/slippageBps/i);
  });

  it("refuses one bp above the ceiling and accepts the ceiling itself", () => {
    expect(() => resolvePendleSlippage(TOOL, VEX_MAX_SLIPPAGE_BPS + 1)).toThrow(/slippageBps/i);
    expect(resolvePendleSlippage(TOOL, VEX_MAX_SLIPPAGE_BPS).bps).toBe(VEX_MAX_SLIPPAGE_BPS);
  });

  it("names the parameter, the tool, the cap and the retry in the refusal", () => {
    let caught: unknown;
    try {
      resolvePendleSlippage(TOOL, 999_999);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(VexError);
    const err = caught as VexError;
    expect(err.code).toBe(ErrorCodes.INVALID_AMOUNT);
    const text = `${err.message} ${err.hint ?? ""}`;
    expect(text).toContain("slippageBps");
    expect(text).toContain(TOOL);
    expect(text).toContain(String(VEX_MAX_SLIPPAGE_BPS));
    expect(text).toMatch(/retry/i);
  });
});

describe("resolvePendleSlippage rejects invalid basis points", () => {
  it("rejects -1 instead of returning the 50 bps default", () => {
    expect(() => resolvePendleSlippage(TOOL, -1)).toThrow(/slippageBps/i);
  });

  it("the -1 rejection explains the rule rather than defaulting", () => {
    let caught: unknown;
    try {
      resolvePendleSlippage(TOOL, -1);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(VexError);
    expect((caught as VexError).code).toBe(ErrorCodes.INVALID_AMOUNT);
  });

  for (const value of [0.5, 50.5, 50.9]) {
    it(`rejects the fractional value ${value}`, () => {
      expect(() => resolvePendleSlippage(TOOL, value)).toThrow(/slippageBps/i);
    });
  }

  it("rejects a non-finite value", () => {
    expect(() => resolvePendleSlippage(TOOL, Number.NaN)).toThrow(/slippageBps/i);
    expect(() => resolvePendleSlippage(TOOL, Number.POSITIVE_INFINITY)).toThrow(/slippageBps/i);
  });
});

describe("resolvePendleSlippage preserves valid behaviour", () => {
  it("an omitted value still takes the documented default", () => {
    const resolved = resolvePendleSlippage(TOOL, undefined);
    expect(resolved.bps).toBe(VEX_DEFAULT_SLIPPAGE_BPS);
    expect(resolved.fraction).toBe(VEX_DEFAULT_SLIPPAGE_BPS / 10_000);
  });

  it.each([
    [0, 0],
    [1, 0.0001],
    [50, 0.005],
    [100, 0.01],
    [250, 0.025],
    [1000, 0.1],
  ])("converts %i bps to the fraction %f and echoes the bps back", (bps, expected) => {
    const resolved = resolvePendleSlippage(TOOL, bps);
    expect(resolved.fraction).toBeCloseTo(expected, 10);
    expect(resolved.bps).toBe(bps);
  });

  it("returns the SAME bps the price floor will be computed from", () => {
    // The floor is derived from `bps`, the quote is sent `fraction`. If these
    // ever disagreed, the guard would hold the route to a tolerance the caller
    // did not trade at, so they come from one resolution.
    const resolved = resolvePendleSlippage(TOOL, 250);
    expect(resolved.fraction).toBe(resolved.bps / 10_000);
  });
});
