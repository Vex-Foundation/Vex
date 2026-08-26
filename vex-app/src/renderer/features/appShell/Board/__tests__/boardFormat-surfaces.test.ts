/**
 * THE v3 FORMATTERS - UTC clocks, and the trade tally's null policy.
 *
 * The clocks are UTC and SAY SO: an unlabelled time is read as local by
 * everyone, and this surface is one where a reader compares a compose clock
 * to a live clock constantly.
 *
 * The trade tally's rule is the interesting one. A row that reported neither
 * side has no trade count and renders the empty dash; a row that reported ONE
 * side reports that side, rather than a fabricated zero for the other. The
 * arithmetic is still on integers throughout - no money crosses into a float.
 */

import { describe, expect, it } from "vitest";
import {
  BOARD_EMPTY,
  formatBoardTradeTotal,
  formatBoardUtcClock,
  formatBoardUtcDate,
} from "../boardFormat.js";

describe("formatBoardUtcClock", () => {
  it.each([
    [Date.UTC(2026, 7, 26, 11, 11), "11:11 UTC"],
    [Date.UTC(2026, 7, 26, 0, 5), "00:05 UTC"],
    [Date.UTC(2026, 7, 26, 23, 59), "23:59 UTC"],
  ])("renders %i as %s", (epochMs, expected) => {
    expect(formatBoardUtcClock(epochMs)).toBe(expected);
  });

  it("returns null rather than a guess for an unusable instant", () => {
    expect(formatBoardUtcClock(Number.NaN)).toBeNull();
    expect(formatBoardUtcClock(Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe("formatBoardUtcDate", () => {
  it.each([
    [Date.UTC(2026, 7, 26), "26 Aug"],
    [Date.UTC(2026, 0, 1), "1 Jan"],
    [Date.UTC(2026, 11, 31), "31 Dec"],
  ])("renders %i as %s", (epochMs, expected) => {
    expect(formatBoardUtcDate(epochMs)).toBe(expected);
  });

  it("returns null for an unusable instant", () => {
    expect(formatBoardUtcDate(Number.NaN)).toBeNull();
  });
});

describe("formatBoardTradeTotal", () => {
  it.each([
    [1235, 856, "2.1K"],
    [900, 500, "1.4K"],
    [400, 582, "982"],
    [0, 0, "0"],
    // One side reported: report it, rather than inventing a zero.
    [1000, null, "1.0K"],
    [null, 12, "12"],
    // Neither side: the empty dash, never a confident zero.
    [null, null, BOARD_EMPTY],
  ])("sums %s and %s to %s", (buys, sells, expected) => {
    expect(formatBoardTradeTotal(buys, sells)).toBe(expected);
  });
});
