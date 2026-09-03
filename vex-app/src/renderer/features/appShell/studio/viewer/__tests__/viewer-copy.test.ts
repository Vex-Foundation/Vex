/**
 * THE SENTENCES, read as writing.
 *
 * `FileViewer.test.tsx` proves WHICH sentence appears in WHICH register for a
 * given state, driving the real component through a fake highlighter. That is
 * the state machine. This file is about the sentences themselves - number
 * agreement, grouping, and the words the budget is spelled in - because those
 * are decided per input value and the component can only ever show the one
 * value the app ships with.
 *
 * `budgetInWords` is the case that needs it. The viewer ships a 500 ms budget
 * and no rendered test can reach any other branch, so without this file the
 * sentence would be correct by coincidence: someone lowering the constant would
 * get a note that reads "Vex colours each line for at most 250 milliseconds"
 * only if the branch below is right, and nothing would have checked it.
 */

import { describe, expect, it } from "vitest";
import { VIEWER_LINE_TIME_BUDGET_MS } from "../file-viewer-session.js";
import {
  highlightBudgetNote,
  longLinesText,
  partlyHighlightedText,
  plainReasonIsExpected,
  plainReasonText,
  type PlainReason,
} from "../viewer-copy.js";

describe("partlyHighlightedText", () => {
  it("agrees in number, and points at the first line", () => {
    expect(partlyHighlightedText(1, 2)).toBe(
      "Partly highlighted: 1 line ran out of highlighting time, first at line 2.",
    );
    expect(partlyHighlightedText(3, 7)).toBe(
      "Partly highlighted: 3 lines ran out of highlighting time, first at line 7.",
    );
  });

  it("groups the digits of both numbers, the way every other bound is written", () => {
    // A minified bundle really can produce these, and `12000` in a sentence is
    // counted digit by digit where `12,000` is read (audit A12).
    expect(partlyHighlightedText(12_000, 145_600)).toBe(
      "Partly highlighted: 12,000 lines ran out of highlighting time, first at line 145,600.",
    );
  });

  /**
   * The COUNT is the count, never the length of the list beside it.
   *
   * The wire bounds the list of line numbers at fifty and does not bound the
   * total. This sentence is handed the total, so a file with two hundred such
   * lines says two hundred - the bound reporting itself rather than reporting
   * its own ceiling as if it were the file's number.
   */
  it("says the total even when far more lines exist than any list would hold", () => {
    expect(partlyHighlightedText(200, 1)).toContain("200 lines");
  });
});

describe("highlightBudgetNote", () => {
  it("spells the shipped budget in words", () => {
    expect(VIEWER_LINE_TIME_BUDGET_MS).toBe(500);
    expect(highlightBudgetNote(VIEWER_LINE_TIME_BUDGET_MS)).toBe(
      "Vex colours each line for at most half a second and keeps what it found by then. Every character is still there.",
    );
  });

  it("spells a whole-second budget in seconds", () => {
    expect(highlightBudgetNote(1_000)).toContain("at most one second and");
    expect(highlightBudgetNote(2_000)).toContain("at most 2 seconds and");
  });

  it("falls back to milliseconds, grouped, for anything else", () => {
    expect(highlightBudgetNote(250)).toContain("at most 250 milliseconds and");
    expect(highlightBudgetNote(1_500)).toContain("at most 1,500 milliseconds and");
  });

  it("always says the text is complete, because that is the point of the note", () => {
    // The budget costs COLOUR and never bytes. A note that only named a limit
    // would leave a reader wondering whether the line itself was cut.
    for (const budget of [250, 500, 1_000, 1_500]) {
      expect(highlightBudgetNote(budget)).toContain("Every character is still there.");
    }
  });
});

describe("the two registers stay separable", () => {
  /**
   * Only the language having no grammar is the ORDINARY state of a file. Every
   * other reason is a bound Vex hit or a failure it had, and the chip exists
   * for those - if the expected case joined them, the announced row would fire
   * on every `.txt` and stop meaning anything (audit A11).
   */
  it("treats no-grammar as expected and every other reason as not", () => {
    const reasons: PlainReason[] = [
      "plain_language",
      "too_large_to_highlight",
      "grammar_unavailable",
      "tokenize_failed",
      "worker_failed",
      "worker_unavailable",
      "malformed_result",
      "too_many_tokens",
    ];
    expect(reasons.filter((reason) => plainReasonIsExpected(reason))).toEqual([
      "plain_language",
    ]);
    // And every one of them has a sentence of its own: a reason that fell
    // through to a shared "not highlighted" would be a code the user cannot act
    // on.
    const sentences = reasons.map((reason) => plainReasonText(reason, 1_024, 512 * 1_024));
    expect(new Set(sentences).size).toBe(reasons.length);
    for (const sentence of sentences) expect(sentence.startsWith("Not highlighted: ")).toBe(true);
  });

  it("keeps the long-line sentence about LENGTH, not about time", () => {
    // Two different bounds with two different remedies; collapsing them would
    // tell a reader with a minified line to wait for a faster machine.
    expect(longLinesText(3, 20_000)).toBe(
      "3 lines are over 20,000 characters and not highlighted.",
    );
    expect(longLinesText(1, 20_000)).toBe(
      "1 line is over 20,000 characters and not highlighted.",
    );
  });
});
