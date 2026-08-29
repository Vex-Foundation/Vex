/**
 * The content budget, tested where it is decidable: on the DATA.
 *
 * Whether a budgeted string then fits its region is a layout fact and belongs
 * to `e2e/board-layout.spec.ts`, which measures it in a real engine over the
 * schema-extreme board at the compact floor. What this file owns is the
 * contract every one of those measurements depends on: the value that leaves
 * this module is never longer than the budget, and it always reports whether
 * it is the whole value.
 */

import { describe, expect, it } from "vitest";
import {
  anyShortened,
  boardCardValue,
  BOARD_CARD_DELTA_MAX_CHARS,
  BOARD_CARD_PRICE_MAX_CHARS,
  BOARD_CARD_STAT_MAX_CHARS,
  BOARD_CARD_TICKER_MAX_CHARS,
} from "../boardCardValueBudget.js";

describe("boardCardValue", () => {
  it("prints a realistic value whole and does not claim a cut", () => {
    // The four strings the floors in `board-layout.css` were derived from.
    // If any of these ever reported `shortened`, the card would be accusing
    // itself of a cut it did not make, and the budget would be wrong rather
    // than the value.
    for (const [text, budget] of [
      ["$0.000001230", BOARD_CARD_PRICE_MAX_CHARS],
      ["$104238.92", BOARD_CARD_PRICE_MAX_CHARS],
      ["+661.00%", BOARD_CARD_DELTA_MAX_CHARS],
      ["-12.48%", BOARD_CARD_DELTA_MAX_CHARS],
      ["$998.8K", BOARD_CARD_STAT_MAX_CHARS],
      ["$1234.5B", BOARD_CARD_STAT_MAX_CHARS],
      ["1095d", BOARD_CARD_STAT_MAX_CHARS],
      ["-", BOARD_CARD_STAT_MAX_CHARS],
      ["DEGEN", BOARD_CARD_TICKER_MAX_CHARS],
      ["WBTC", BOARD_CARD_TICKER_MAX_CHARS],
    ] as const) {
      expect(boardCardValue(text, budget)).toEqual({ text, shortened: false });
    }
  });

  it("shortens a schema extreme to the budget and says it did", () => {
    // A 40-character decimal and a 512-character symbol both parse.
    const price = boardCardValue(
      "$1234567890123456789012345678901234.56",
      BOARD_CARD_PRICE_MAX_CHARS,
    );
    expect(price.shortened).toBe(true);
    // One character short of the budget, because the ellipsis is charged two
    // slots for a glyph that is nearly two digits wide.
    expect(price.text).toHaveLength(BOARD_CARD_PRICE_MAX_CHARS - 1);
    expect(price.text.endsWith("…")).toBe(true);

    const ticker = boardCardValue("X".repeat(512), BOARD_CARD_TICKER_MAX_CHARS);
    expect(ticker.shortened).toBe(true);
    expect(ticker.text).toHaveLength(BOARD_CARD_TICKER_MAX_CHARS - 1);
  });

  it("never exceeds the budget, at the boundary or one past it", () => {
    for (const budget of [2, 8, 10, 11, 12]) {
      for (const length of [budget - 1, budget, budget + 1, budget + 400]) {
        const value = boardCardValue("9".repeat(length), budget);
        expect(value.text.length).toBeLessThanOrEqual(budget);
        expect(value.shortened).toBe(length > budget);
      }
    }
  });

  it("keeps one character visible even at an absurd budget", () => {
    // The shortest honest output is something plus the mark that says there
    // was more, never the mark alone.
    const value = boardCardValue("123456", 1);
    expect(value.text).toBe("1…");
    expect(value.shortened).toBe(true);
  });
});

describe("anyShortened", () => {
  it("is true when any one value conceded, and false when none did", () => {
    const whole = boardCardValue("WBTC", BOARD_CARD_TICKER_MAX_CHARS);
    const cut = boardCardValue("X".repeat(64), BOARD_CARD_TICKER_MAX_CHARS);
    expect(anyShortened([whole, whole])).toBe(false);
    expect(anyShortened([whole, cut])).toBe(true);
    expect(anyShortened([])).toBe(false);
  });
});
