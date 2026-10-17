/**
 * The content budget, tested where it is decidable: on the DATA.
 *
 * Whether a budgeted string then fits its region is a layout fact and belongs
 * to `e2e/board-layout.spec.ts`, which measures it in a real engine over the
 * schema-extreme board at the tile floor. What this file owns is the
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
    // The strings the floor in `board-layout.css` was derived from. If any of
    // these ever reported `shortened`, the tile would be accusing itself of a
    // cut it did not make, and the budget would be wrong rather than the
    // value.
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
      expect(
        boardCardValue(symbol, BOARD_CARD_TICKER_MAX_SLOTS, "proportional"),
      ).toEqual({ text: symbol, shortened: false });
    }
  });
});

/**
 * THE PROPORTIONAL SURFACE. The ticker is not `tabular-nums`: it renders in
 * Instrument Sans regular at 12.5px, whose advances run from `I` at 3.18px to
 * `W` at 13.61px against a slot of 9.1px (the widest glyph the allowlist
 * admits, `V` and `A`). Counting characters there is not measuring width, and
 * this is what says so.
 */
describe("boardCardValue on the proportional surface", () => {
  it("charges a wide Latin glyph two slots and a narrow one one", () => {
    // Measured at 12.5px: W 13.61, M 11.32, Q 9.84, % and O 9.82, G 9.56,
    // D 9.40, C 9.26, H and N 9.20 - every one past the 9.1px slot. (U, at
    // 8.90, is charged two as well: over-charging is the safe direction.)
    // E 7.97, A 9.10, I 3.18 - every one inside it.
    for (const wide of ["W", "M", "C", "D", "G", "H", "N", "O", "Q", "U", "%"]) {
      expect(boardCardValueSlots(wide, "proportional")).toBe(2);
    }
    for (const narrow of ["A", "B", "E", "F", "I", "L", "S", "T", "Z", "1"]) {
      expect(boardCardValueSlots(narrow, "proportional")).toBe(1);
    }
    // The SAME characters cost one slot on the tabular surface, because there
    // every digit really does advance by the same width.
    expect(boardCardValueSlots("WWWWWWWW", "tabular")).toBe(8);
  });

  it("shortens WWWWWWWW, which a character count let through", () => {
    // THE DEFECT: eight characters, eight of ten slots under a count, and
    // 107px of glyphs against the 91px a ten-slot ticker may take - clipped,
    // with `shortened` false and a neutral affordance saying nothing had been
    // cut.
    expect(boardCardValueSlots("WWWWWWWW", "proportional")).toBe(16);
    const printed = boardCardValue(
      "WWWWWWWW",
      BOARD_CARD_TICKER_MAX_SLOTS,
      "proportional",
    );
    expect(printed.shortened).toBe(true);
    expect(printed.text).toBe("WWWW…");
    // 4 x 13.61 is 54.4px and the ellipsis 8.2px: inside the 91px a ten-slot
    // ticker may take, and inside the 120px identity column.
    expect(
      boardCardValueSlots(printed.text.slice(0, -1), "proportional"),
    ).toBeLessThanOrEqual(BOARD_CARD_TICKER_MAX_SLOTS - 2);
  });

  it("weighs a lowercase glyph as its capital, which is the safe direction", () => {
    // The tile no longer forces capitals, but a lowercase glyph is still
    // weighed as its capital, which is never narrower than what renders: the
    // widest lowercase among the one-slot capitals is 7.6px against the 9.1px
    // slot, and `w` (9.6px) and `m` (11.5px), which ARE wider than a slot,
    // land in the two-slot class as `W` and `M`.
    expect(boardCardValueSlots("wwwwwwww", "proportional")).toBe(16);
    expect(
      boardCardValue("wwwwwwww", BOARD_CARD_TICKER_MAX_SLOTS, "proportional")
        .shortened,
    ).toBe(true);
  });

  it("charges an unmeasured Latin-1 glyph the wide weight", () => {
    // The class is an ALLOWLIST of glyphs measured inside a slot, so a
    // character the schema admits and nobody measured is charged two rather
    // than assumed innocent.
    for (const unmeasured of ["@", "&", "#", "é", "Ñ", "©"]) {
      expect(boardCardValueSlots(unmeasured, "proportional")).toBe(2);
    }
  });

  it("keeps every realistic ticker whole at its own budget", () => {
    // The over-charging must not turn into a cut on tickers a real market
    // actually uses - a false "shortened" is its own kind of dishonesty.
    for (const symbol of [
      "WBTC",
      "PEPE",
      "DEGEN",
      "TOSHI",
      "USDC",
      "AERO",
      "MATIC",
      "PENDLE",
      "BITCOIN",
    ]) {
      expect(
        boardCardValue(symbol, BOARD_CARD_TICKER_MAX_SLOTS, "proportional"),
      ).toEqual({ text: symbol, shortened: false });
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

/**
 * THE BUDGETS AGREE WITH THE FLOOR. Each budget is a number of slots, and each
 * region of the tile has a column the floor leaves it. This is the arithmetic
 * of `board-layout.css` and `board-layout-measurements.md`, in the one place a
 * change to a budget constant would otherwise slip past: raise a budget past
 * its column and the tile cuts a figure with `shortened` still false.
 *
 * The advances are computed from the shipped font files (JetBrains Mono
 * advances 0.6em; Instrument Sans measured with kerning), so they are the
 * browser's numbers to within a pixel and the e2e matrix re-measures them in
 * a real engine.
 */
describe("the budgets fit the columns the tile floor leaves", () => {
  /**
   * The tile's inner floor: the price row binds at whole-pixel advances (it
   * measures 287), see board-layout.css.
   */
  const FLOOR_INNER = 288;
  /** JetBrains Mono 13 with `.vex-num` at -.01em: 7.8 - 0.13. */
  const MONO_13 = 7.67;
  /** JetBrains Mono 26 / 500 at -.03em: 15.6 - 0.78. */
  const MONO_26 = 14.82;
  /** `24h` in Instrument Sans 12. */
  const WINDOW_24H = 20.51;
  /** The widest glyph the proportional allowlist admits, at 12.5px. */
  const SLOT = 9.1;

  it("fits the widest price, delta and window on one row at the floor", () => {
    const row =
      BOARD_CARD_PRICE_MAX_SLOTS * MONO_26 +
      10 +
      BOARD_CARD_DELTA_MAX_SLOTS * MONO_13 +
      10 +
      WINDOW_24H;
    expect(row).toBeLessThanOrEqual(FLOOR_INNER);
    // And it is the row the floor was derived from, not slack: one more slot
    // on the price would push the row past it.
    expect(row + MONO_26).toBeGreaterThan(FLOOR_INNER);
  });

  it("fits the same row at whole-pixel glyph advances, which Linux Chromium paints", () => {
    // Chromium on Linux without subpixel text positioning rounds each glyph
    // advance to a whole pixel: the mono 26 advance 15.6 becomes 16 (15.22
    // after the -.03em tracking), the mono 13 advance 7.8 becomes 8 (7.87
    // after -.01em), and `24h` measures 21.5 instead of 20.51. The fractional
    // row of 279.71 above is then 287.1, which is what made 282 too narrow.
    const priceRounded = BOARD_CARD_PRICE_MAX_SLOTS * (16 - 0.78);
    const deltaRounded = BOARD_CARD_DELTA_MAX_SLOTS * (8 - 0.13);
    const row = priceRounded + 10 + deltaRounded + 10 + 21.5;
    expect(row).toBeLessThanOrEqual(FLOOR_INNER);
    // The rounding is what moved the floor: the same row does not fit 282.
    expect(row).toBeGreaterThan(282);
  });

  it("fits the widest stat value in a column of four, and one more slot would not", () => {
    const column = (FLOOR_INNER - 3 * 6) / 4;
    expect(BOARD_CARD_STAT_MAX_SLOTS * MONO_13).toBeLessThanOrEqual(column);
    expect((BOARD_CARD_STAT_MAX_SLOTS + 1) * MONO_13).toBeGreaterThan(column);
  });

  it("keeps a ten-slot ticker inside the identity column", () => {
    // 34 photo + 11 + [identity] + 11 + (26 key + 6 + 74 chip).
    const identity = FLOOR_INNER - (34 + 11 + 11 + 26 + 6 + 74);
    expect(identity).toBe(126);
    expect(BOARD_CARD_TICKER_MAX_SLOTS * SLOT).toBeLessThanOrEqual(identity);
  });
});
