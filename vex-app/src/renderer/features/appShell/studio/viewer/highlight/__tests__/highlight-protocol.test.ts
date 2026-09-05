/**
 * THE WIRE ITSELF: what a worker may say, and what the renderer refuses to hear.
 *
 * `isHighlightResponse` is the only thing standing between a message that came
 * out of a separate build and renderer state. Both ends are ours, so this is
 * not a trust boundary - it is a PROCESS boundary, and the failure it exists
 * for is a stale chunk or a half-applied protocol change rather than an
 * attacker.
 *
 * That makes the ADDITIVE-CHANGE rule the case worth pinning: when the wire
 * grows a field on a success, the guard requires it immediately. A worker built
 * before the change then fails here, the port answers `malformed_result` and
 * the viewer shows honest plain text - instead of rendering a file as fully
 * highlighted while the bound it no longer reports goes unsaid. A test that
 * only asserted the happy shape would not notice that rule being relaxed to an
 * optional field, which is why the omission cases below are the point of this
 * file.
 */

import { describe, expect, it } from "vitest";
import {
  countLines,
  HIGHLIGHT_BUDGET_LINES_LISTED,
  isHighlightResponse,
  type HighlightResponse,
  type HighlightSuccess,
} from "../highlight-protocol.js";

/** A well-formed success, and the one place this file spells the shape. */
function success(overrides: Partial<HighlightSuccess> = {}): HighlightSuccess {
  return {
    kind: "result",
    requestId: 7,
    ok: true,
    lines: [[{ text: "const", color: "var(--x)", italic: false, bold: true, underline: false }], []],
    longLines: 0,
    budgetExceededLines: [2],
    budgetExceededTotal: 2,
    ...overrides,
  };
}

/** A success with one field removed, as a stale worker would send it. */
function without(field: keyof HighlightSuccess): unknown {
  const { [field]: _removed, ...rest } = success();
  return rest;
}

describe("isHighlightResponse", () => {
  it("accepts a success carrying every field, budget report included", () => {
    const response: unknown = success();
    expect(isHighlightResponse(response)).toBe(true);
    // And it narrows, which is what the port relies on to read the fields.
    if (!isHighlightResponse(response)) return;
    expect(response.kind).toBe("result");
    if (response.kind !== "result" || !response.ok) return;
    expect(response.budgetExceededLines).toEqual([2]);
    expect(response.budgetExceededTotal).toBe(2);
  });

  it("accepts ready, and every coded failure", () => {
    expect(isHighlightResponse({ kind: "ready" })).toBe(true);
    for (const reason of ["grammar_unavailable", "tokenize_failed", "too_many_tokens"]) {
      expect(isHighlightResponse({ kind: "result", requestId: 1, ok: false, reason })).toBe(
        true,
      );
    }
    expect(
      isHighlightResponse({ kind: "result", requestId: 1, ok: false, reason: "invented" }),
    ).toBe(false);
  });

  /**
   * THE ADDITIVE-CHANGE RULE. A success missing ANY field a consumer reads is
   * refused, and the two budget fields are held to exactly the standard
   * `lines` and `longLines` are. Relaxing either to optional turns one of these
   * green, which is the point.
   */
  it("REFUSES a success missing any field, including the budget report", () => {
    for (const field of [
      "lines",
      "longLines",
      "budgetExceededLines",
      "budgetExceededTotal",
    ] as const) {
      expect(isHighlightResponse(without(field))).toBe(false);
    }
  });

  /**
   * A malformed value is built as `unknown` rather than cast through the typed
   * shape: the guard's own parameter IS `unknown`, so a cast would only be
   * silencing the compiler about a value this test wants to be wrong.
   */
  it("refuses a budget report of the wrong shape", () => {
    const total: unknown = { ...success(), budgetExceededTotal: "2" };
    expect(isHighlightResponse(total)).toBe(false);

    const notAList: unknown = { ...success(), budgetExceededLines: "2" };
    expect(isHighlightResponse(notAList)).toBe(false);

    // A list whose entries are not numbers: the chip would print a line number
    // the file has no line for.
    const notNumbers: unknown = { ...success(), budgetExceededLines: ["2"] };
    expect(isHighlightResponse(notNumbers)).toBe(false);
  });

  it("refuses anything that is not a response at all", () => {
    for (const value of [null, undefined, 7, "result", [], { kind: "other" }]) {
      expect(isHighlightResponse(value)).toBe(false);
    }
  });

  /**
   * The guard proves SHAPE and never QUANTITY: it does not know what was asked,
   * so a list of line numbers pointing outside the file passes here and is
   * refused by the port, which does. Pinned so the division of labour stays
   * deliberate rather than becoming a hole neither side covers.
   */
  it("does not police the line numbers, which is the port's job", () => {
    expect(
      isHighlightResponse(success({ budgetExceededLines: [900], budgetExceededTotal: 1 })),
    ).toBe(true);
  });
});

describe("countLines", () => {
  it("counts CRLF and LF alike, and a lone CR not at all", () => {
    expect(countLines("a\nb")).toBe(2);
    expect(countLines("a\r\nb")).toBe(2);
    expect(countLines("a\rb")).toBe(1);
    // A trailing terminator opens a final, empty line: it is a line the viewer
    // renders as a blank row, not a line that is missing.
    expect(countLines("a\n")).toBe(2);
    expect(countLines("")).toBe(1);
  });
});

describe("the list bound", () => {
  it("is a bound on the LIST and never on the count", () => {
    // The value both ends compare against, written down so a change to it is a
    // change someone makes rather than a number that drifted.
    expect(HIGHLIGHT_BUDGET_LINES_LISTED).toBe(50);
    // A truncated list beside a larger total is a WELL-FORMED response: that is
    // the bound reporting itself, and how many were left out is derivable.
    const response: HighlightResponse = success({
      lines: Array.from({ length: 200 }, () => []),
      budgetExceededLines: Array.from({ length: 50 }, (_unused, at) => at + 1),
      budgetExceededTotal: 200,
    });
    expect(isHighlightResponse(response)).toBe(true);
  });
});
