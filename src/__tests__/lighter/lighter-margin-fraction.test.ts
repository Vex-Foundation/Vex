/**
 * The Lighter margin-fraction unit, table-tested at the exact values the live
 * provider was measured emitting on 2026-09-10.
 *
 * WHY THIS UNIT HAS A TEST OF ITS OWN. Lighter reports the same concept three
 * ways: the market endpoint and the wire use a 10000-scale integer (5000), the
 * account endpoint uses a percent string ("50.00"), and the vendor's own SDK
 * takes a leverage on one method and a fraction on another. Every one of those
 * numbers ends up in a sentence a human reads before consenting to change the
 * margin on a real position, so a conversion that is one tick out is a consent
 * defect, not a formatting defect.
 *
 * The assertions below are on the OBSERVABLE result of each conversion, and the
 * boundary cases are the ones that decide money: the smallest and largest
 * fraction the provider accepts, the rounding direction in both conversions,
 * and every shape the parser must refuse rather than default.
 */

import { describe, expect, it } from "vitest";

import { ErrorCodes, VexError } from "../../errors.js";
import {
  LIGHTER_MARGIN_FRACTION_TICK,
  LIGHTER_MARGIN_MODE_WIRE,
  initialMarginFractionToLeverageDisplay,
  leverageToInitialMarginFraction,
  marginModeFromWire,
  positionInitialMarginFractionToProviderScale,
} from "@tools/lighter/margin-fraction.js";

/**
 * Every refusal in this module is a VexError carrying an existing Lighter error
 * code, never a bare TypeError from arithmetic on a bad value and never a
 * silent default. Which code says where the bad value came from: a malformed
 * provider reading is an invalid RESPONSE, a caller asking for an impossible
 * leverage is an invalid REQUEST.
 */
function expectRefusal(act: () => unknown, code: string): void {
  let thrown: unknown;
  try {
    act();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(VexError);
  expect((thrown as VexError).code).toBe(code);
  expect((thrown as VexError).hint ?? "").not.toBe("");
}

describe("Lighter margin mode", () => {
  it("maps both provider codes and refuses any other", () => {
    expect(LIGHTER_MARGIN_MODE_WIRE).toEqual({ cross: 0, isolated: 1 });
    expect(marginModeFromWire(0)).toBe("cross");
    expect(marginModeFromWire(1)).toBe("isolated");
    // A mode Vex does not know must not fall back to cross: cross and isolated
    // liquidate differently, so a guess would put a wrong sentence in front of
    // the user.
    for (const unknown of [2, -1, 255, 1.5, Number.NaN]) {
      expectRefusal(() => marginModeFromWire(unknown), ErrorCodes.LIGHTER_INVALID_RESPONSE);
    }
  });
});

describe("Lighter account percent string to the canonical integer", () => {
  it.each([
    { percent: "50.00", scaled: 5000, note: "the owner's live ETH position row" },
    { percent: "2.00", scaled: 200, note: "the RHC market minimum, 50x" },
    { percent: "33.33", scaled: 3333, note: "a value no float round-trips exactly" },
    { percent: "100.00", scaled: LIGHTER_MARGIN_FRACTION_TICK, note: "1x, fully margined" },
    { percent: "100", scaled: LIGHTER_MARGIN_FRACTION_TICK, note: "no decimal point" },
    { percent: "0.01", scaled: 1, note: "the smallest fraction the provider accepts" },
    { percent: "1.2", scaled: 120, note: "one decimal is padded, not truncated" },
    { percent: " 50.00 ", scaled: 5000, note: "surrounding whitespace" },
  ])("reads $percent as $scaled ($note)", ({ percent, scaled }) => {
    expect(positionInitialMarginFractionToProviderScale(percent)).toBe(scaled);
  });

  it.each([
    { percent: "0.00", why: "a position with no margin is not a readable state" },
    { percent: "0", why: "zero" },
    { percent: "-50.00", why: "negative" },
    { percent: "100.01", why: "above 100 percent" },
    { percent: "150.00", why: "above 100 percent" },
    { percent: "50.001", why: "more precision than the provider emits" },
    { percent: "", why: "empty" },
    { percent: "abc", why: "not a number" },
    { percent: "NaN", why: "NaN as text" },
    { percent: "5e1", why: "exponent notation" },
    { percent: "+50.00", why: "a sign the provider never sends" },
    { percent: ".5", why: "no whole part" },
    { percent: "99999999999999999999999.00", why: "outside the readable integer range" },
  ])("refuses $percent ($why)", ({ percent }) => {
    expectRefusal(
      () => positionInitialMarginFractionToProviderScale(percent),
      ErrorCodes.LIGHTER_INVALID_RESPONSE,
    );
  });
});

describe("Lighter leverage to the canonical integer", () => {
  it.each([
    { leverage: 1, fraction: 10000 },
    { leverage: 2, fraction: 5000 },
    { leverage: 3, fraction: 3334 },
    { leverage: 20, fraction: 500 },
    { leverage: 25, fraction: 400 },
    { leverage: 50, fraction: 200 },
    { leverage: 7, fraction: 1429 },
    { leverage: 10000, fraction: 1 },
  ])("converts $leverage x to $fraction", ({ leverage, fraction }) => {
    expect(leverageToInitialMarginFraction(leverage)).toBe(fraction);
  });

  it("rounds UP, so the account never gets more leverage than the user asked for", () => {
    // The vendor SDK truncates here (`imf = int(10_000 / leverage)`), which
    // gives 3333 for 3x - slightly MORE than 3x. Vex rounds the other way.
    expect(leverageToInitialMarginFraction(3)).toBe(3334);
    expect(leverageToInitialMarginFraction(3)).toBeGreaterThan(
      Math.trunc(LIGHTER_MARGIN_FRACTION_TICK / 3),
    );
    expect(leverageToInitialMarginFraction(7)).toBeGreaterThan(
      Math.trunc(LIGHTER_MARGIN_FRACTION_TICK / 7),
    );
  });

  it.each([0, -1, 1.5, 10001, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER])(
    "refuses %p",
    (leverage) => {
      expectRefusal(
        () => leverageToInitialMarginFraction(leverage),
        ErrorCodes.LIGHTER_INVALID_REQUEST,
      );
    },
  );
});

describe("Canonical integer to the leverage a human reads", () => {
  it.each([
    { fraction: 10000, display: "1.00" },
    { fraction: 5000, display: "2.00" },
    { fraction: 3334, display: "2.99" },
    { fraction: 3333, display: "3.00" },
    { fraction: 500, display: "20.00" },
    { fraction: 400, display: "25.00" },
    { fraction: 200, display: "50.00" },
    { fraction: 1, display: "10000.00" },
  ])("renders $fraction as $display x", ({ fraction, display }) => {
    expect(initialMarginFractionToLeverageDisplay(fraction)).toBe(display);
  });

  it("truncates rather than rounds, so the display never overstates the position", () => {
    // 3334 is 2.9994x. Rounding would print 3.00x and tell the user they have
    // leverage the exchange will not give them.
    expect(initialMarginFractionToLeverageDisplay(3334)).toBe("2.99");
  });

  it("round-trips every whole leverage the product offers", () => {
    for (let leverage = 1; leverage <= 100; leverage += 1) {
      const fraction = leverageToInitialMarginFraction(leverage);
      const display = initialMarginFractionToLeverageDisplay(fraction);
      // Rounding up the fraction and truncating the display both lean the same
      // way, so the displayed leverage is never above the requested one.
      expect(Number(display)).toBeLessThanOrEqual(leverage);
      expect(Number(display)).toBeGreaterThan(leverage - 1);
    }
  });

  it.each([0, -1, 10001, 1.5, Number.NaN])("refuses %p", (fraction) => {
    expectRefusal(
      () => initialMarginFractionToLeverageDisplay(fraction),
      ErrorCodes.LIGHTER_INVALID_REQUEST,
    );
  });
});

