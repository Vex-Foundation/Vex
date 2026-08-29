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
  boardCardValueSlots,
  boardCardValue,
  BOARD_CARD_DELTA_MAX_SLOTS,
  BOARD_CARD_PRICE_MAX_SLOTS,
  BOARD_CARD_STAT_MAX_SLOTS,
  BOARD_CARD_TICKER_MAX_SLOTS,
} from "../boardCardValueBudget.js";

describe("boardCardValue", () => {
  it("prints a realistic value whole and does not claim a cut", () => {
    // The four strings the floors in `board-layout.css` were derived from.
    // If any of these ever reported `shortened`, the card would be accusing
    // itself of a cut it did not make, and the budget would be wrong rather
    // than the value.
    for (const [text, budget] of [
      ["$0.000001230", BOARD_CARD_PRICE_MAX_SLOTS],
      ["$104238.92", BOARD_CARD_PRICE_MAX_SLOTS],
      ["+661.00%", BOARD_CARD_DELTA_MAX_SLOTS],
      ["-12.48%", BOARD_CARD_DELTA_MAX_SLOTS],
      ["$998.8K", BOARD_CARD_STAT_MAX_SLOTS],
      ["$1234.5B", BOARD_CARD_STAT_MAX_SLOTS],
      ["1095d", BOARD_CARD_STAT_MAX_SLOTS],
      ["-", BOARD_CARD_STAT_MAX_SLOTS],
      ["DEGEN", BOARD_CARD_TICKER_MAX_SLOTS],
      ["WBTC", BOARD_CARD_TICKER_MAX_SLOTS],
    ] as const) {
      expect(boardCardValue(text, budget)).toEqual({ text, shortened: false });
    }
  });

  it("shortens a schema extreme to the budget and says it did", () => {
    // A 40-character decimal and a 512-character symbol both parse.
    const price = boardCardValue(
      "$1234567890123456789012345678901234.56",
      BOARD_CARD_PRICE_MAX_SLOTS,
    );
    expect(price.shortened).toBe(true);
    // One character short of the budget, because the ellipsis is charged two
    // slots for a glyph that is nearly two digits wide.
    expect(price.text).toHaveLength(BOARD_CARD_PRICE_MAX_SLOTS - 1);
    expect(price.text.endsWith("…")).toBe(true);

    const ticker = boardCardValue("X".repeat(512), BOARD_CARD_TICKER_MAX_SLOTS);
    expect(ticker.shortened).toBe(true);
    expect(ticker.text).toHaveLength(BOARD_CARD_TICKER_MAX_SLOTS - 1);
  });

  it("never exceeds the budget, at the boundary or one past it", () => {
    // Every budget the card actually uses is 8 or more. The one exception to
    // "never exceeds" is the documented clamp - one cluster plus the mark
    // survives even when the budget cannot pay for both - and it is asserted
    // as itself rather than smuggled past this loop.
    for (const budget of [8, 10, 11, 12]) {
      for (const length of [budget - 1, budget, budget + 1, budget + 400]) {
        const value = boardCardValue("9".repeat(length), budget);
        expect(boardCardValueSlots(value.text)).toBeLessThanOrEqual(budget);
        expect(value.shortened).toBe(length > budget);
      }
    }
  });

  it("keeps one cluster visible even at an absurd budget", () => {
    // The shortest honest output is something plus the mark that says there
    // was more, never the mark alone - so at a budget too small to pay for
    // both, the clamp deliberately spends one slot more rather than printing
    // a value that names nothing. No card uses a budget this small.
    for (const budget of [1, 2, 3]) {
      const value = boardCardValue("123456", budget);
      expect(value.text).toBe("1…");
      expect(value.shortened).toBe(true);
    }
    // And the clamp keeps a WHOLE cluster, never half of one.
    const emoji = boardCardValue("👨‍👩‍👧‍👦👩‍💻", 1);
    expect(emoji.text).toBe("👨‍👩‍👧‍👦…");
    expect(emoji.text).toBe(emoji.text.toWellFormed());
  });
});

/**
 * SCHEMA-VALID UNICODE. `baseTokenSymbol` is `z.string().min(1).max(512)`:
 * 512 UTF-16 code units of anything at all. These are the cases a budget
 * counted in `String.length` and cut with `String.slice` got wrong.
 */
describe("boardCardValue over non-Latin tickers", () => {
  const CJK = "比特币现金交易所代币";
  const FAMILY = "👨‍👩‍👧‍👦";
  const FLAG = "🇯🇵";
  const COMBINING = "é"; // e + combining acute, one cluster

  it("charges a wide character two slots, so a short CJK ticker is cut", () => {
    // THE DEFECT: ten CJK characters are ten `String.length` and sat under a
    // ten-character budget while rendering at twice the width the budget was
    // measured against - overflowing the column with `shortened` false.
    expect(CJK.length).toBe(10);
    expect(boardCardValueSlots(CJK)).toBe(20);
    const printed = boardCardValue(CJK, BOARD_CARD_TICKER_MAX_SLOTS);
    expect(printed.shortened).toBe(true);
    expect(boardCardValueSlots(printed.text)).toBeLessThanOrEqual(
      BOARD_CARD_TICKER_MAX_SLOTS,
    );
  });

  it("never splits a grapheme cluster", () => {
    // A ZWJ family is ONE cluster of seven code points and eleven code units.
    // Cutting inside it renders a different token than the provider sent.
    const printed = boardCardValue(
      FAMILY.repeat(6),
      BOARD_CARD_TICKER_MAX_SLOTS,
    );
    expect(printed.shortened).toBe(true);
    const withoutMark = printed.text.slice(0, -1);
    expect(withoutMark).toBe(FAMILY.repeat(withoutMark.length / FAMILY.length));

    // A regional-indicator flag is one cluster of two astral code points.
    const flags = boardCardValue(FLAG.repeat(8), BOARD_CARD_TICKER_MAX_SLOTS);
    expect(flags.text.slice(0, -1).length % FLAG.length).toBe(0);

    // A combining mark never outlives the base character it belongs to.
    const marks = boardCardValue(
      COMBINING.repeat(20),
      BOARD_CARD_TICKER_MAX_SLOTS,
    );
    expect(marks.text.startsWith(COMBINING)).toBe(true);
    expect(marks.text.slice(0, -1).length % COMBINING.length).toBe(0);
  });

  it("never emits a lone surrogate, at any budget or any boundary", () => {
    // THE PERSISTENCE BOUNDARY, not only the pixels: an ill-formed string is
    // what a code-unit slice through a surrogate pair produces, and it travels
    // on into jsonb. Every budget from 1 up is walked over strings whose
    // clusters straddle every possible cut point.
    const subjects = [
      "𝐀𝐁𝐂𝐃𝐄𝐅",
      `A${FAMILY}B${FLAG}C`,
      `${CJK}${FLAG}`,
      `${COMBINING}𝐀${FAMILY}`,
    ];
    for (const subject of subjects) {
      for (let budget = 1; budget <= 24; budget += 1) {
        const { text } = boardCardValue(subject, budget);
        expect(text).toBe(text.toWellFormed());
        // And nothing is invented: what survives is a prefix of the original.
        const body = text.endsWith("…") ? text.slice(0, -1) : text;
        expect(subject.startsWith(body)).toBe(true);
      }
    }
  });

  it("leaves a Latin ticker exactly where it was", () => {
    // The realistic path must not move because the Unicode path was fixed.
    for (const symbol of ["WBTC", "PEPE", "DEGEN", "TOSHI", "USDC"]) {
      expect(boardCardValue(symbol, BOARD_CARD_TICKER_MAX_SLOTS)).toEqual({
        text: symbol,
        shortened: false,
      });
    }
  });
});

describe("anyShortened", () => {
  it("is true when any one value conceded, and false when none did", () => {
    const whole = boardCardValue("WBTC", BOARD_CARD_TICKER_MAX_SLOTS);
    const cut = boardCardValue("X".repeat(64), BOARD_CARD_TICKER_MAX_SLOTS);
    expect(anyShortened([whole, whole])).toBe(false);
    expect(anyShortened([whole, cut])).toBe(true);
    expect(anyShortened([])).toBe(false);
  });
});
