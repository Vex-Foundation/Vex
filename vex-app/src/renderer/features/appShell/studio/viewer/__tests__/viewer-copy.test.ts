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
import { HOT_LANGUAGES, PLAIN_LANGUAGE } from "../highlight/language-of-path.js";
import {
  highlightBudgetNote,
  languageHasNoGrammar,
  longLinesText,
  partlyHighlightedText,
  plainReasonText,
  refusalKindLabel,
  revealRefusalText,
  viewerKindLabel,
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
   * AUDIT A11, second pass. The first fix demoted the no-grammar sentence from
   * an announced chip to quiet copy and the audit measured it AGAIN, because a
   * grammar sentence on a file that has no grammar is noise in either register.
   * The predicate now reads the LANGUAGE RESOLUTION: `text` is what
   * `language-of-path.ts` returns when nothing was ever going to run, and every
   * hot language is a file the highlighter really does work on - so a plain
   * state there is a bound Vex hit or a failure it had, and it keeps its chip.
   */
  it("treats a grammarless kind as silent and every hot language as reportable", () => {
    expect(languageHasNoGrammar(PLAIN_LANGUAGE)).toBe(true);
    for (const language of HOT_LANGUAGES) {
      expect(languageHasNoGrammar(language), language).toBe(false);
    }
  });

  it("keeps a sentence of its own for every plain reason", () => {
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
    // A reason that fell through to a shared "not highlighted" would be a code
    // the user cannot act on.
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

/* ------------------------------------------------------------------ *
 * The kind label (audit A13)
 * ------------------------------------------------------------------ */

describe("viewerKindLabel", () => {
  /**
   * The measured defect: `assets/image.png` was refused as `invalid_utf8` and
   * the header still read `Plain text`, because `.png` is an extension no
   * grammar claims. The header now takes the kind from the refusal, which is
   * the only one of the two answers that was established by reading bytes.
   */
  it.each([
    ["binary", "Binary"],
    ["invalid_utf8", "Not UTF-8"],
    ["too_large", "Too large"],
    ["symlinked_path", "Symbolic link"],
    ["not_a_file", "Not a file"],
    ["not_found", "Missing"],
  ] as const)("labels a %s refusal as %s, never the path's language", (code, label) => {
    expect(viewerKindLabel(PLAIN_LANGUAGE, code)).toBe(label);
    // ...and it OVERRIDES a confident path-derived language too: a `.ts` file
    // whose bytes are not UTF-8 is not TypeScript on screen, it is bytes.
    expect(viewerKindLabel("typescript", code)).toBe(label);
  });

  it("keeps the path-derived language when the refusal names no kind", () => {
    // These say something about the environment, not about the file: calling a
    // TypeScript file in a closed project anything but TypeScript would be
    // inventing a detection nobody made.
    for (const code of ["project_closed", "root_unavailable", "io_error", "invalid_node", "path_changed"] as const) {
      expect(refusalKindLabel(code)).toBeNull();
      expect(viewerKindLabel("typescript", code)).toBe("TypeScript");
    }
  });

  it("uses the language when there is no refusal at all", () => {
    expect(viewerKindLabel("typescript", null)).toBe("TypeScript");
    expect(viewerKindLabel(PLAIN_LANGUAGE, null)).toBe("Plain text");
  });
});

/* ------------------------------------------------------------------ *
 * Reveal (audit A14)
 * ------------------------------------------------------------------ */

describe("revealRefusalText", () => {
  it("says what happened for every refusal the resolution can produce", () => {
    const codes = [
      "not_found",
      "symlinked_path",
      "outside_project",
      "project_closed",
      "invalid_node",
      "root_unavailable",
      "io_error",
    ] as const;
    const sentences = codes.map((code) => revealRefusalText(code));
    expect(new Set(sentences).size).toBe(codes.length);
    // None of them blames Vex for a failure it did not have, and none of them
    // claims to know what the desktop did.
    for (const sentence of sentences) {
      expect(sentence.endsWith(".")).toBe(true);
      expect(sentence).not.toContain("file manager did not");
    }
  });

  it("names the code rather than pretending to know an unreachable one", () => {
    // `watcher_limit` belongs to the subscription surface and cannot reach a
    // reveal. An honest fallback beats a reassuring sentence.
    expect(revealRefusalText("watcher_limit")).toContain("watcher_limit");
  });
});
