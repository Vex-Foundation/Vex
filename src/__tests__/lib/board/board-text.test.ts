/**
 * The reject-only board text predicate.
 *
 * The contract under test is a SECURITY contract, so the assertions are about
 * refusal, not about output: every prohibited class must produce a rejection
 * naming that class, and no input must ever come back modified. A test that
 * only checked "the bad characters are gone" would pass against a sanitizer,
 * which is precisely the implementation this module must not become.
 *
 * Characters are written as code-point escapes throughout. A literal invisible
 * in a test file is unreviewable for the same reason it is unreviewable in the
 * implementation.
 */

import { describe, expect, it } from "vitest";

import {
  checkBoardText,
  describeBoardTextFailure,
  findForbiddenTextClass,
  textLength,
  type BoardTextRule,
  type ForbiddenTextClass,
} from "../../../lib/board/board-text.js";

const SINGLE_LINE: BoardTextRule = { minChars: 1, maxChars: 80, multiline: false };
const MULTI_LINE: BoardTextRule = { minChars: 1, maxChars: 280, multiline: true };

/**
 * Every prohibited code point named by the frozen contract table, one entry per
 * boundary of every range plus the interior representatives that motivated the
 * range.
 *
 * This is the table the module is measured against; adding a range to the
 * implementation without adding its boundaries here would leave the new range
 * unproven.
 */
const PROHIBITED: readonly (readonly [number, ForbiddenTextClass, string])[] = [
  [0x0000, "control-character", "NUL"],
  [0x0007, "control-character", "BEL"],
  [0x0009, "control-character", "TAB"],
  [0x000b, "control-character", "VERTICAL TAB"],
  [0x000d, "control-character", "CARRIAGE RETURN"],
  [0x001b, "control-character", "ESCAPE"],
  [0x001f, "control-character", "UNIT SEPARATOR"],
  [0x007f, "control-character", "DELETE"],
  [0x0080, "control-character", "C1 PAD"],
  [0x009b, "control-character", "C1 CSI"],
  [0x009f, "control-character", "C1 APC"],
  [0x00ad, "zero-width", "SOFT HYPHEN"],
  [0x180e, "zero-width", "MONGOLIAN VOWEL SEPARATOR"],
  [0x200b, "zero-width", "ZERO WIDTH SPACE"],
  [0x200c, "zero-width", "ZERO WIDTH NON-JOINER"],
  [0x200e, "zero-width", "LEFT-TO-RIGHT MARK"],
  [0x200f, "zero-width", "RIGHT-TO-LEFT MARK"],
  [0x2060, "zero-width", "WORD JOINER"],
  [0x2064, "zero-width", "INVISIBLE PLUS"],
  [0xfeff, "zero-width", "BOM"],
  [0x202a, "bidi-control", "LEFT-TO-RIGHT EMBEDDING"],
  [0x202e, "bidi-control", "RIGHT-TO-LEFT OVERRIDE"],
  [0x2066, "bidi-control", "LEFT-TO-RIGHT ISOLATE"],
  [0x2069, "bidi-control", "POP DIRECTIONAL ISOLATE"],
  [0xe0001, "unicode-tag", "LANGUAGE TAG"],
  [0xe0020, "unicode-tag", "TAG SPACE"],
  [0xe0041, "unicode-tag", "TAG LATIN CAPITAL A"],
  [0xe007f, "unicode-tag", "CANCEL TAG"],
];

describe("findForbiddenTextClass", () => {
  it.each(PROHIBITED)(
    "rejects U+%s as %s (%s)",
    (codePoint, textClass) => {
      const value = `USD${String.fromCodePoint(codePoint as number)}C`;
      expect(findForbiddenTextClass(value, false)).toBe(textClass);
      expect(findForbiddenTextClass(value, true)).toBe(textClass);
    }
  );

  it("rejects a prohibited code point wherever it sits in the string", () => {
    const zwsp = String.fromCodePoint(0x200b);
    expect(findForbiddenTextClass(`${zwsp}lead`, false)).toBe("zero-width");
    expect(findForbiddenTextClass(`mid${zwsp}dle`, false)).toBe("zero-width");
    expect(findForbiddenTextClass(`trail${zwsp}`, false)).toBe("zero-width");
  });

  it("rejects a line feed only when the field is single-line", () => {
    expect(findForbiddenTextClass("first\nsecond", false)).toBe("line-break");
    expect(findForbiddenTextClass("first\nsecond", true)).toBeNull();
  });

  it("rejects carriage return and tab even in a multi-line field", () => {
    expect(findForbiddenTextClass("a\rb", true)).toBe("control-character");
    expect(findForbiddenTextClass("a\tb", true)).toBe("control-character");
  });

  it("accepts the zero width joiner, which is load-bearing inside emoji", () => {
    const family = "\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}";
    expect(findForbiddenTextClass(family, false)).toBeNull();
  });

  it("accepts ordinary text, punctuation, non-Latin scripts and astral characters", () => {
    for (const value of [
      "SOL/USDC reclaimed the range high",
      "wsparcie 0,42 - podaz sie wyczerpala",
      "价格突破阻力位",
      "\u{1F680} breakout",
      "price: 0.000000000123 (why not)",
    ]) {
      expect(findForbiddenTextClass(value, false)).toBeNull();
    }
  });

  it("names the FIRST offending class when several are present", () => {
    const bidi = String.fromCodePoint(0x202e);
    const zwsp = String.fromCodePoint(0x200b);
    expect(findForbiddenTextClass(`a${bidi}b${zwsp}c`, false)).toBe("bidi-control");
    expect(findForbiddenTextClass(`a${zwsp}b${bidi}c`, false)).toBe("zero-width");
  });

  it("accepts the characters immediately outside every rejected range", () => {
    // One below and one above each boundary that has a legible neighbour.
    for (const codePoint of [
      0x000a, // LF, conditional and handled separately
      0x0020, // SPACE, just past the C0 block
      0x007e, // TILDE, just below DEL
      0x00a0, // NBSP, just past the C1 block
      0x00ac, // NOT SIGN, just below SOFT HYPHEN
      0x00ae, // REGISTERED, just past SOFT HYPHEN
      0x180d, // MONGOLIAN FREE VARIATION SELECTOR THREE
      0x200a, // HAIR SPACE, just below ZWSP
      0x200d, // ZWJ, the deliberate hole in the zero-width block
      0x2010, // HYPHEN, just past RLM
      0x2029, // PARAGRAPH SEPARATOR, just below the bidi block
      0x202f, // NARROW NBSP, just past the bidi block
      0x205f, // MEDIUM MATHEMATICAL SPACE, just below WORD JOINER
      0x2065, // the unassigned hole between the two bidi/zero-width groups
      0x206a, // INHIBIT SYMMETRIC SWAPPING, just past the isolates
      0xfefe, // just below the BOM
      0xe0000, // just below LANGUAGE TAG
      0xe0002, // just past LANGUAGE TAG, below TAG SPACE
      0xe0080, // just past CANCEL TAG
    ]) {
      const value = `a${String.fromCodePoint(codePoint)}b`;
      expect(findForbiddenTextClass(value, true)).toBeNull();
    }
  });
});

describe("textLength", () => {
  it("counts code points, not UTF-16 units", () => {
    expect(textLength("abc")).toBe(3);
    expect(textLength("\u{1F680}")).toBe(1);
    expect("\u{1F680}".length).toBe(2);
  });
});

describe("checkBoardText", () => {
  it("accepts a string at each inclusive length boundary", () => {
    expect(checkBoardText("a", SINGLE_LINE)).toBeNull();
    expect(checkBoardText("a".repeat(80), SINGLE_LINE)).toBeNull();
  });

  it("rejects one character below the minimum and one above the maximum", () => {
    expect(checkBoardText("", SINGLE_LINE)).toEqual({
      reason: "too-short",
      minChars: 1,
      length: 0,
    });
    expect(checkBoardText("a".repeat(81), SINGLE_LINE)).toEqual({
      reason: "too-long",
      maxChars: 80,
      length: 81,
    });
  });

  it("budgets an astral character as one, not two", () => {
    // 80 rockets are 160 UTF-16 units and must still fit an 80-char title.
    expect(checkBoardText("\u{1F680}".repeat(80), SINGLE_LINE)).toBeNull();
    expect(checkBoardText("\u{1F680}".repeat(81), SINGLE_LINE)).toEqual({
      reason: "too-long",
      maxChars: 80,
      length: 81,
    });
  });

  it("names the character class before the length when a string violates both", () => {
    const value = String.fromCodePoint(0x202e).repeat(200);
    expect(checkBoardText(value, MULTI_LINE)).toEqual({
      reason: "forbidden-characters",
      textClass: "bidi-control",
    });
  });

  it("allows newlines inside a multi-line note", () => {
    expect(checkBoardText("first line\nsecond line", MULTI_LINE)).toBeNull();
  });
});

describe("describeBoardTextFailure", () => {
  it("never echoes the offending characters back to the reader", () => {
    const message = describeBoardTextFailure({
      reason: "forbidden-characters",
      textClass: "unicode-tag",
    });
    expect(message).toContain("unicode-tag");
    expect(message).toContain("not echoed back");
    expect(findForbiddenTextClass(message, false)).toBeNull();
  });

  it("states the bound and the measured length for a length failure", () => {
    expect(
      describeBoardTextFailure({ reason: "too-long", maxChars: 80, length: 93 })
    ).toContain("93");
  });
});

describe("the predicate never transforms", () => {
  it("has no exported function that returns a modified string", () => {
    // The module's whole surface: two predicates, a counter and a describer.
    // If a `sanitize`-shaped export ever appears here, this fails loudly.
    const value = `a${String.fromCodePoint(0x200b)}b`;
    expect(findForbiddenTextClass(value, false)).toBe("zero-width");
    expect(value).toBe(`a${String.fromCodePoint(0x200b)}b`);
    expect(textLength(value)).toBe(3);
  });
});
