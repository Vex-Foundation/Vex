/**
 * The tokenizer, against the REAL shiki 4.4.3 - no worker, no fake grammar.
 *
 * A fake here would prove nothing that matters. Every claim this module makes
 * is a claim about a third-party library's behaviour: that the css-variables
 * theme writes `var(--vex-alias-code-token-keyword)` and not a hex, that
 * `tokenizeMaxLineLength` emits ONE token for a long line, that a plain-text id
 * is a real answer rather than an error, that a missing grammar is a rejection
 * we can turn into a code. So the library runs for real and the assertions are
 * about what it actually produced.
 *
 * The theme slot names asserted below were read out of the installed
 * `@shikijs/core/dist/index.mjs` (`createCssVariablesTheme`), which is also
 * where `CODE_THEME_SLOTS` comes from. This suite is what keeps the stylesheet,
 * the tokenizer and the library in one contract.
 */

import { describe, expect, it } from "vitest";
import {
  CODE_THEME_SLOTS,
  CODE_VARIABLE_PREFIX,
  createTokenizer,
  hotLanguagesWithoutLoader,
  LINE_TIME_BUDGET_MS,
  projectLines,
  type TokenizedToken,
  type TokenizeOutcome,
} from "../shiki-tokenizer.js";
import { HOT_LANGUAGES, PLAIN_LANGUAGE } from "../language-of-path.js";
import { createCssVariablesTheme, createHighlighterCore } from "@shikijs/core";
import { createJavaScriptRegexEngine } from "@shikijs/engine-javascript";
import type { LanguageRegistration, ThemedToken } from "@shikijs/types";
import {
  HIGHLIGHT_BUDGET_LINES_LISTED,
  type TokenizeResult,
  type TokenLine,
} from "../highlight-protocol.js";

const NO_LINE_BOUND = 0;
/** Zero disables the token bound, the way `NO_LINE_BOUND` disables the other. */
const NO_TOKEN_BOUND = 0;
/** Zero disables vscode-textmate's per-line clock, the same way. */
const NO_TIME_BUDGET = 0;

function flatten(result: TokenizeResult): string {
  return result.lines.map((line) => line.map((token) => token.text).join("")).join("\n");
}

/**
 * A whole file through the real tokenizer at a given per-line budget, or a
 * thrown refusal the caller did not ask for.
 *
 * At module scope because both budget suites below need it: the one that pins
 * WHICH lines ran out of clock, and the one that pins what the line AFTER an
 * abandoned line is coloured from.
 */
async function tokenizeAll(source: string, budgetMs: number): Promise<TokenizeResult> {
  const tokenizer = createTokenizer({ lineTimeBudgetMs: budgetMs });
  const outcome = await tokenizer.tokenize(source, "typescript", NO_LINE_BOUND, NO_TOKEN_BOUND);
  tokenizer.dispose();
  if (!outcome.ok) throw new Error(`tokenizing refused: ${outcome.reason}`);
  return outcome.result;
}

function colours(result: TokenizeResult): string[] {
  return result.lines.flatMap((line) =>
    line.flatMap((token) => (token.color === null ? [] : [token.color])),
  );
}

describe("the loader table", () => {
  it("has a loader for every hot language", () => {
    expect(hotLanguagesWithoutLoader()).toEqual([]);
  });

  it("exposes exactly the slots the installed css-variables theme emits", () => {
    // The ANSI slots are deliberately absent; see the module note.
    expect([...CODE_THEME_SLOTS]).toEqual([
      "foreground",
      "background",
      "token-constant",
      "token-string",
      "token-comment",
      "token-keyword",
      "token-parameter",
      "token-function",
      "token-string-expression",
      "token-punctuation",
      "token-link",
      "token-inserted",
      "token-deleted",
      "token-changed",
    ]);
    expect(CODE_VARIABLE_PREFIX).toBe("--vex-alias-code-");
  });
});

describe("tokenize", () => {
  it("gives a TypeScript keyword and string their own theme variables", async () => {
    // NO CLOCK. This asserts what the grammar and the theme produce, and
    // vscode-textmate's per-line budget would otherwise make that a function of
    // how loaded the machine is: the first line of the first file pays for the
    // grammar's lazy pattern compilation, and on a busy runner that crossed
    // shiki's 500ms default and the string arrived uncoloured. See the
    // budget-is-visible case below for the mechanism.
    const tokenizer = createTokenizer({ lineTimeBudgetMs: NO_TIME_BUDGET });
    const source = 'const greeting = "hello";\n';
    const outcome = await tokenizer.tokenize(source, "typescript", NO_LINE_BOUND, NO_TOKEN_BOUND);
    tokenizer.dispose();

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    // Nothing is lost: the tokens reassemble into the file.
    expect(flatten(outcome.result)).toBe(source.replace(/\n$/, "\n"));
    const used = colours(outcome.result);
    expect(used).toContain("var(--vex-alias-code-token-keyword)");
    expect(used).toContain("var(--vex-alias-code-token-string-expression)");
    // Every colour is a variable reference. A hex here would be a colour
    // decision made inside the tokenizer, invisible to the theme flip.
    for (const colour of used) {
      expect(colour.startsWith("var(--vex-alias-code-")).toBe(true);
    }
  });

  /**
   * THE PER-LINE CLOCK, made visible and pinned.
   *
   * vscode-textmate stops scanning a line once `Date.now()` says the budget is
   * spent and hands back what it has, so a line can come out byte-exact and
   * half-coloured with nothing said about it. That is what made the colour
   * assertion above fail on a loaded runner while passing in isolation, and it
   * is why the budget is now this module's declared policy rather than shiki's
   * silent 500ms default.
   *
   * The experiment is deterministic by MARGIN, not by hope. RE-MEASURED against
   * the installed shiki 4.4.3 (the first reading of it, "about 1.1 seconds",
   * was a whole-file number and is corrected here): this 750-character line
   * costs 19 to 33 ms of scanning warm, held over sixty consecutive lines with
   * no decay, and 24 to 114 ms on a freshly built highlighter where the
   * grammar's lazy pattern compilation is still unpaid. Against a
   * one-millisecond budget that is a twentyfold overrun at its cheapest, so the
   * scan cannot finish; the unbudgeted run is then a function of the grammar
   * alone. The case goes red if the option stops reaching shiki, which is the
   * regression that produced the flake.
   *
   * The timeout is generous because this is real tokenizing on a shared
   * runner, and no assertion here is about elapsed time.
   */
  it("abandons the rest of a line when the budget runs out, losing colour and no bytes", async () => {
    const line = 'const a = "x"; '.repeat(50);
    expect(line.length).toBeGreaterThanOrEqual(750);

    const budgeted = createTokenizer({ lineTimeBudgetMs: 1 });
    const stopped = await budgeted.tokenize(line, "typescript", NO_LINE_BOUND, NO_TOKEN_BOUND);
    budgeted.dispose();

    const unbudgeted = createTokenizer({ lineTimeBudgetMs: NO_TIME_BUDGET });
    const complete = await unbudgeted.tokenize(line, "typescript", NO_LINE_BOUND, NO_TOKEN_BOUND);
    unbudgeted.dispose();

    expect(stopped.ok).toBe(true);
    expect(complete.ok).toBe(true);
    if (!stopped.ok || !complete.ok) return;

    // The budget costs COLOUR and nothing else: both projections are the file.
    expect(flatten(stopped.result)).toBe(line);
    expect(flatten(complete.result)).toBe(line);
    expect(new Set(colours(stopped.result)).size).toBeLessThan(
      new Set(colours(complete.result)).size,
    );
    // And the value the viewer ships with is the one written down.
    expect(LINE_TIME_BUDGET_MS).toBe(500);
    // THE FACT IS NOW REPORTED, which is the whole of UX-8: before this field
    // existed the assertion above was all anyone could make, and the viewer
    // showed this line as if it were finished.
    expect(stopped.result.budgetExceededTotal).toBe(1);
    expect(stopped.result.budgetExceededLines).toEqual([1]);
    expect(complete.result.budgetExceededTotal).toBe(0);
    expect(complete.result.budgetExceededLines).toEqual([]);
  }, 60_000);

  it("answers plain text with one uncoloured token per line", async () => {
    const tokenizer = createTokenizer();
    const outcome = await tokenizer.tokenize(
      "alpha\nbeta\n\ngamma",
      PLAIN_LANGUAGE,
      NO_LINE_BOUND,
      NO_TOKEN_BOUND,
    );
    tokenizer.dispose();

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.lines).toHaveLength(4);
    expect(colours(outcome.result)).toEqual([]);
    // The empty line is an EMPTY array, not a missing line.
    expect(outcome.result.lines[2]).toEqual([]);
    expect(flatten(outcome.result)).toBe("alpha\nbeta\n\ngamma");
    expect(outcome.result.longLines).toBe(0);
  });

  it("emits an over-length line as ONE plain token and COUNTS it", async () => {
    const tokenizer = createTokenizer();
    const long = `const x = "${"a".repeat(200)}";`;
    const source = `const short = 1;\n${long}\nconst after = 2;`;
    const outcome = await tokenizer.tokenize(source, "typescript", 100, NO_TOKEN_BOUND);
    tokenizer.dispose();

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.lines).toHaveLength(3);
    // The bound REPORTS itself. This is the number the chip shows.
    expect(outcome.result.longLines).toBe(1);
    const longLine = outcome.result.lines[1] ?? [];
    expect(longLine).toHaveLength(1);
    expect(longLine[0]?.color).toBeNull();
    expect(longLine[0]?.text).toBe(long);
    // The short lines around it are still highlighted.
    expect(colours(outcome.result).length).toBeGreaterThan(0);
    // And nothing was cut.
    expect(flatten(outcome.result)).toBe(source);
  });

  it("applies the same long-line accounting to plain text", async () => {
    const tokenizer = createTokenizer();
    const outcome = await tokenizer.tokenize(
      `${"z".repeat(50)}\nshort`,
      PLAIN_LANGUAGE,
      10,
      NO_TOKEN_BOUND,
    );
    tokenizer.dispose();
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.longLines).toBe(1);
  });

  it("answers grammar_unavailable for a language outside the hot set", async () => {
    const tokenizer = createTokenizer();
    const outcome = await tokenizer.tokenize("SELECT 1", "cobol", NO_LINE_BOUND, NO_TOKEN_BOUND);
    tokenizer.dispose();
    expect(outcome).toEqual({ ok: false, reason: "grammar_unavailable" });
  });

  it("answers grammar_unavailable when a loader REJECTS, and does not throw", async () => {
    const tokenizer = createTokenizer({
      loaders: {
        typescript: () => Promise.reject(new Error("chunk load failed")),
      },
    });
    const outcome = await tokenizer.tokenize("const a = 1;", "typescript", NO_LINE_BOUND, NO_TOKEN_BOUND);
    tokenizer.dispose();
    expect(outcome).toEqual({ ok: false, reason: "grammar_unavailable" });
  });

  it("retries a rejected loader on the next file rather than caching the failure", async () => {
    let attempt = 0;
    const real = await import("@shikijs/langs/typescript");
    const tokenizer = createTokenizer({
      loaders: {
        typescript: () => {
          attempt += 1;
          return attempt === 1
            ? Promise.reject(new Error("transient"))
            : Promise.resolve(real);
        },
      },
    });

    expect(await tokenizer.tokenize("const a = 1;", "typescript", NO_LINE_BOUND, NO_TOKEN_BOUND)).toEqual({
      ok: false,
      reason: "grammar_unavailable",
    });
    const second = await tokenizer.tokenize("const a = 1;", "typescript", NO_LINE_BOUND, NO_TOKEN_BOUND);
    tokenizer.dispose();
    expect(second.ok).toBe(true);
    expect(attempt).toBe(2);
  });

  it("tokenizes a 512 KiB file to completion", async () => {
    // No timing assertion - jsdom under a loaded CI runner is not a stopwatch.
    // The claim is only that the session's byte bound is a size the tokenizer
    // can actually finish, so the bound is a policy and not a workaround.
    const tokenizer = createTokenizer();
    const line = 'export const value = { key: "value", n: 1 };\n';
    const source = line.repeat(Math.ceil((512 * 1024) / line.length));
    expect(source.length).toBeGreaterThanOrEqual(512 * 1024);

    const outcome = await tokenizer.tokenize(source, "typescript", 20_000, NO_TOKEN_BOUND);
    tokenizer.dispose();
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.longLines).toBe(0);
    expect(outcome.result.lines.length).toBeGreaterThan(10_000);
  });

  it("loads and tokenizes EVERY hot grammar with forgiving: false", async () => {
    // The probe that fixed the hot set. `forgiving: false` raises on an
    // Oniguruma pattern the JavaScript engine cannot convert, so a grammar that
    // would degrade silently in production fails loudly right here.
    const tokenizer = createTokenizer();
    const failures: string[] = [];
    for (const language of HOT_LANGUAGES) {
      const outcome = await tokenizer.tokenize(
        '# a\nconst a = "b"\n<x y="z">\nSELECT 1;\n',
        language,
        20_000,
        NO_TOKEN_BOUND,
      );
      if (!outcome.ok) failures.push(`${language}: ${outcome.reason}`);
    }
    tokenizer.dispose();
    expect(failures).toEqual([]);
  }, 60_000);

  it("stops answering after dispose", async () => {
    const tokenizer = createTokenizer();
    tokenizer.dispose();
    expect(await tokenizer.tokenize("const a = 1;", "typescript", NO_LINE_BOUND, NO_TOKEN_BOUND)).toEqual({
      ok: false,
      reason: "tokenize_failed",
    });
  });
});

/**
 * WHICH LINES RAN OUT OF CLOCK, and why the numbers can be asserted exactly.
 *
 * The fixture is deterministic BY CONSTRUCTION rather than by timing luck, and
 * the construction is the point:
 *
 *  - the lines that must be reported are the 750-character pathological line
 *    the case above re-measures at 19 to 33 ms of scanning warm and 24 to
 *    114 ms cold. Against a one-millisecond budget that is a twentyfold overrun
 *    at its cheapest, so the scan cannot reach the end of the line. The margin
 *    is real but it is TWENTY, not a thousand: one run of this suite has been
 *    seen to report 59 of these 60 lines, which is the one place this file is
 *    known to be able to flake;
 *  - the lines that must NOT be reported are EMPTY. An empty line never reaches
 *    the grammar at all - the loop emits `[]` and moves on - so it cannot be
 *    reported however loaded the runner is. An ordinary short line WOULD be a
 *    coin flip here: measured against this tokenizer, `const s = 1;` trips a
 *    one-millisecond budget on some runs and not others, which is exactly the
 *    flake that has no place in an exactness assertion.
 *
 * What that buys is the assertion worth making: the line NUMBERS are right.
 * They are 1-based and they have to survive the lines the loop skips without
 * scanning, which is the indexing most likely to be off by one or off by the
 * count of blanks.
 */
describe("the per-line budget reports WHICH lines it stopped on", () => {
  /**
   * A LINE THAT IS ABANDONED ON EVERY RUN, cold or warm.
   *
   * The fixture this describe used to share was fifty short statements: 19 to
   * 33 ms warm, thirty times a one-millisecond budget, which is comfortable for
   * ONE line and not enough for the exactness these cases assert over two and
   * over sixty of them. A run measured 59 abandoned lines out of 60, and one
   * measured line 2 or line 4 finishing - a flake in an assertion whose whole
   * value is that it is exact.
   *
   * This is the construction measured deterministic for exactly this question
   * (see "the line after an abandoned one is coloured from the PRE-LINE state"
   * below, where the measurement is written out): a backtick at character 0,
   * then 20,000 `\x41` escapes. 80,001 characters and 20,000 MATCH rules -
   * nothing pushed onto the stack, nothing popped - so it costs 31 to 51 ms
   * warm and is abandoned whichever side of the clock the run lands on.
   *
   * THAT COST IS THE COST OF BEING ABANDONED, not the cost of the line. With
   * the clock OFF the same line runs to the end and a two-line file of it took
   * more than 170 seconds on the reference machine - three runs, deterministic
   * - which is why the control below has a fixture of its own and its own
   * measurement rather than reusing this one.
   *
   * The template literal it opens is never closed, and does not need to be:
   * the line AFTER an abandoned one is coloured from the PRE-line state, so
   * every one of these lines starts at the top level and is abandoned on its
   * own terms rather than inheriting a scope from the line above.
   */
  const OVERRUNS = `\`${"\\x41".repeat(20_000)}`;
  /**
   * A line that costs about 170 ms of colouring - some 170 times a
   * one-millisecond budget, and still a sixth of a second when nothing stops
   * it. The control's fixture; the measurement is on the case itself.
   */
  const EXPENSIVE_ENOUGH = `const deep = ${"(".repeat(1_500)}1`;
  const ONE_MS = 1;

  it("names the exact 1-based lines, counting the lines it never scanned", async () => {
    const source = ["", OVERRUNS, "", OVERRUNS, ""].join("\n");
    const result = await tokenizeAll(source, ONE_MS);

    expect(result.budgetExceededLines).toEqual([2, 4]);
    expect(result.budgetExceededTotal).toBe(2);
    // And the file is all there, which is the other half of the contract.
    expect(flatten(result)).toBe(source);
  }, 60_000);

  /**
   * THE CONTROL: the clock is the only thing that reports a line.
   *
   * Without it the case above could pass on a report that fires for every line
   * of every file, which would be a chip that always shows.
   *
   * IT HAS ITS OWN FIXTURE, and it has to. A control for "the clock is off"
   * must let the line RUN TO THE END, so its fixture is priced by what the line
   * costs when nothing stops it - and `OVERRUNS` costs more than 170 seconds
   * for two lines under those conditions, which is a suite that times out
   * rather than a control that proves anything.
   *
   * `EXPENSIVE_ENOUGH` is priced for exactly this: 1,500 unclosed parentheses,
   * which the TypeScript grammar's arrow-function lookahead re-scans quadratically.
   * Measured on the reference machine, three warm runs of the same two-line
   * file through the real tokenizer:
   *
   *   clock off -> 482, 319, 348 ms, and nothing reported;
   *   clock at 1 ms -> 30, 4, 4 ms, and lines 2 and 4 reported, every run.
   *
   * About 170 ms of work per line against a one-millisecond budget is the
   * margin that makes the paired assertion below deterministic on a faster box
   * as well as on a slower one.
   */
  it("reports NOTHING when the clock is off, and everything when it is on", async () => {
    const source = ["", EXPENSIVE_ENOUGH, "", EXPENSIVE_ENOUGH, ""].join("\n");

    const withoutClock = await tokenizeAll(source, NO_TIME_BUDGET);
    expect(withoutClock.budgetExceededTotal).toBe(0);
    expect(withoutClock.budgetExceededLines).toEqual([]);

    // THE PAIRING, on one file: the same bytes, the same grammar, and the only
    // difference is the budget. Without this half the case above would still
    // pass on a tokenizer that never reports anything at all.
    const withClock = await tokenizeAll(source, ONE_MS);
    expect(withClock.budgetExceededLines).toEqual([2, 4]);
    // And every byte survives either way, which is the other half of the
    // contract: the budget stops COLOURING, never reading.
    expect(flatten(withoutClock)).toBe(source);
    expect(flatten(withClock)).toBe(source);
  }, 60_000);

  /**
   * THE LIST IS BOUNDED; THE COUNT IS NOT.
   *
   * A minified bundle read with the line bound disabled can put one entry per
   * line into this list, so the list has a ceiling. What must NEVER be bounded
   * is the count: the chip says how many lines it happened to, and a count that
   * silently stopped at fifty would be the bound lying about the file.
   */
  it("lists the first fifty and still counts every one", async () => {
    const lines = 60;
    const result = await tokenizeAll(
      Array.from({ length: lines }, () => OVERRUNS).join("\n"),
      ONE_MS,
    );

    expect(result.budgetExceededTotal).toBe(lines);
    expect(result.budgetExceededLines).toHaveLength(HIGHLIGHT_BUDGET_LINES_LISTED);
    // The FIRST fifty, in file order: the chip points at the earliest one.
    expect(result.budgetExceededLines).toEqual(
      Array.from({ length: HIGHLIGHT_BUDGET_LINES_LISTED }, (_unused, at) => at + 1),
    );
    // How many were left out is derivable, which is what makes this a bound
    // rather than a silent cut.
    expect(result.budgetExceededTotal - result.budgetExceededLines.length).toBe(
      lines - HIGHLIGHT_BUDGET_LINES_LISTED,
    );
  }, 120_000);

  /**
   * WHY THE FLAG HAD TO COME FROM THE GRAMMAR, pinned as a measurement.
   *
   * The cheap alternative would have been to keep `codeToTokensBase` and infer
   * an abandoned line from its tokens - "the tokens do not cover the line", or
   * "the last token is suspiciously long". This case is the evidence that the
   * first of those is impossible and the second is a guess.
   *
   * vscode-textmate closes the last token at the line's end
   * (`getBinaryResult(ruleStack, lineLength)`), so an abandoned line is covered
   * edge to edge exactly like a finished one. What is left is a long tail token
   * under the scope the scanner was in - and a long string literal, a base64
   * blob or a minified tail produces the same shape with no clock involved. A
   * fallback built on it would both MISS abandoned lines whose tail happens to
   * be short and INVENT them on ordinary files, which on a chip that claims to
   * report a bound is worse than saying nothing.
   */
  it("cannot be detected from token coverage: the abandoned line is still fully covered", async () => {
    const result = await tokenizeAll(OVERRUNS, ONE_MS);
    expect(result.budgetExceededLines).toEqual([1]);

    const line = result.lines[0] ?? [];
    // Edge to edge. There is no gap for a coverage check to find.
    expect(line.map((token) => token.text).join("")).toBe(OVERRUNS);
    // And the remainder arrived as ONE token, which is the only trace left -
    // and a shape ordinary files produce too.
    expect((line.at(-1)?.text.length ?? 0)).toBeGreaterThan(1);
  }, 60_000);
});

/**
 * THE REWIND: an abandoned line does not colour the next one.
 *
 * VS Code returns the state from the START of a line the clock abandoned
 * (`agents-colab/vscode/src/vs/workbench/services/textMate/browser/
 * tokenizationSupport/textMateTokenizationSupport.ts:62-66`), shiki propagates
 * the half-walked stack, and this module follows VS Code. That is a decision
 * about COLOUR, so it is pinned as an experiment on colour rather than on the
 * shape of a state object nobody can see.
 *
 * ## The fixture is deterministic in the one way this experiment needs
 *
 * The pathological line the suites above use is the WRONG fixture here, and the
 * reason is worth writing down because it looks right. Where a line is abandoned
 * decides which stack the rejected policy would have handed on, and that line's
 * cost is dominated by the grammar's LAZY pattern compilation on a fresh
 * highlighter (MEASURED at 24 to 114 ms cold, and about 30 ms once the process
 * has done it a few times). Cold, it is abandoned after roughly one match; warm,
 * it is not abandoned at all. So the state it would propagate is a function of
 * how many suites ran before it - which is a flake, not an experiment.
 *
 * This fixture removes the question instead of hoping about it:
 *
 *  - the abandoned line OPENS ITS SCOPE AT CHARACTER 0 (a backtick, an
 *    unterminated template literal). vscode-textmate always performs the first
 *    match before it looks at its clock (`@shikijs/vscode-textmate/dist/
 *    index.js:1810-1820`, the check at the top of the loop), so the template is
 *    on the stack whatever the clock does next;
 *  - its body is 20,000 `\x41` ESCAPES, and an escape is a match rule, not a
 *    begin/end rule. Nothing is pushed and nothing is popped for the rest of the
 *    line, so EVERY point at which the clock could stop carries the same stack:
 *    inside the template literal, one frame deep. The rejected policy therefore
 *    has exactly one outcome to produce, not a range of them;
 *  - and the escapes are what make it expensive without a pathological grammar:
 *    80,001 characters and 20,000 matches cost 31 to 51 ms WARM, thirty times
 *    the one-millisecond budget, so the line is abandoned whether the process
 *    is cold or hot.
 *
 * MEASURED over twenty fresh highlighters, each run under both policies, cold
 * core and warm: the rewind produced `const` in the keyword colour with no
 * string colour on the line, 20/20; propagating the half-walked stack produced
 * the whole line as ONE token in the template-string colour, 20/20. A
 * millisecond of machine load would have turned the rest of that file into a
 * string.
 */
describe("the line after an abandoned one is coloured from the PRE-LINE state", () => {
  /**
   * Opens a template literal at character 0, then 80,000 characters that push
   * nothing. See the note above for why both halves matter.
   */
  const OPENS_A_SCOPE = `\`${"\\x41".repeat(20_000)}`;
  /** Short, ordinary, and unambiguous under either policy. */
  const AFTER = "const s = 1;";
  const SOURCE = [OPENS_A_SCOPE, AFTER].join("\n");
  const STRING_COLOUR = "var(--vex-alias-code-token-string-expression)";
  const KEYWORD_COLOUR = "var(--vex-alias-code-token-keyword)";
  const ONE_MS = 1;

  it("does not inherit the scope the abandoned line was standing in", async () => {
    const result = await tokenizeAll(SOURCE, ONE_MS);

    // The premise: line 1 really was abandoned. Asserted first so a machine
    // fast enough to finish it fails HERE, with the reason legible, instead of
    // failing the colour assertions for an unrelated reason.
    expect(result.budgetExceededLines).toContain(1);
    // Bytes are untouched by any of this, as they are on every other path.
    expect(flatten(result)).toBe(SOURCE);

    const after = result.lines[1] ?? [];
    expect(after[0]?.text).toBe("const");
    expect(after[0]?.color).toBe(KEYWORD_COLOUR);
    // The whole of the rejected policy, in one assertion: propagating the
    // half-walked stack puts this line inside the template literal and every
    // token of it comes back in the string colour.
    expect(after.some((token) => token.color === STRING_COLOUR)).toBe(false);
  }, 60_000);

  it("changes NOTHING when the line was not abandoned: the open template still carries", async () => {
    // The control, and the other half of the contract. With the clock off the
    // same file finishes line 1, the template literal is genuinely open, and
    // line 2 IS a string - which is the grammar's answer and must stay the
    // grammar's answer. A rewind that fired on finished lines would break this.
    const result = await tokenizeAll(SOURCE, NO_TIME_BUDGET);

    expect(result.budgetExceededTotal).toBe(0);
    expect(result.lines[1]).toEqual([
      { text: AFTER, color: STRING_COLOUR, italic: false, bold: false, underline: false },
    ]);
  }, 60_000);
});

/**
 * THE PROJECTION IS STILL SHIKI'S, and this is the assertion that proves it.
 *
 * Driving `grammar.tokenizeLine2` ourselves means this module now owns the
 * colour-map lookup and the two bit accessors that `@shikijs/primitive` used to
 * own for it. Those are copied literals over a third-party bit layout, so the
 * guard cannot be a comment naming the masks: it has to be shiki's own answer,
 * computed independently, and compared token for token.
 *
 * The comparison highlighter is built here from the same public pieces the
 * tokenizer uses rather than borrowed from it - an independent construction, so
 * a mistake in the tokenizer's setup cannot hide inside a shared one. A mask
 * that drifts in a shiki upgrade turns every colour wrong and this goes red,
 * which is the only assertion about a bit field worth having.
 *
 * THE ONE PLACE THE TWO PATHS NOW DIVERGE, by design, is the line after a line
 * the clock abandoned: shiki hands on the half-walked rule stack and this module
 * hands on the pre-line state (the suite above measures both sides). Every case
 * here runs with `NO_TIME_BUDGET`, so no line can be abandoned and the equality
 * asserted below is the whole contract for the path that finished. An equality
 * case at a real budget would be asserting the divergence away.
 */
describe("the grammar-driven loop matches shiki's own projection", () => {
  /** Every token as the viewer will see it, from OUR path. */
  async function ourProjection(source: string, language: string): Promise<TokenLine[]> {
    const tokenizer = createTokenizer({ lineTimeBudgetMs: NO_TIME_BUDGET });
    const outcome = await tokenizer.tokenize(
      source,
      language,
      NO_LINE_BOUND,
      NO_TOKEN_BOUND,
    );
    tokenizer.dispose();
    if (!outcome.ok) throw new Error(`tokenizing refused: ${outcome.reason}`);
    return outcome.result.lines.map((line) => [...line]);
  }

  /**
   * The same file through SHIKI's `codeToTokensBase`, normalised the way
   * `projectLines` normalises ours.
   *
   * The highlighter is constructed here from the same public pieces rather than
   * borrowed from the tokenizer, so a mistake in the tokenizer's own setup
   * cannot hide inside a shared instance.
   */
  async function shikiProjection(
    source: string,
    language: "typescript" | "markdown",
    registration: LanguageRegistration[],
  ): Promise<TokenLine[]> {
    const core = await createHighlighterCore({
      engine: createJavaScriptRegexEngine({ forgiving: false }),
      themes: [
        createCssVariablesTheme({
          name: "comparison",
          variablePrefix: CODE_VARIABLE_PREFIX,
          fontStyle: true,
        }),
      ],
      langs: [],
    });
    await core.loadLanguage(registration);
    const lines = core.codeToTokensBase(source, {
      lang: language,
      tokenizeMaxLineLength: NO_LINE_BOUND,
      tokenizeTimeLimit: NO_TIME_BUDGET,
    });
    core.dispose();
    return lines.map((line) =>
      line.map((token) => ({
        text: token.content,
        color: token.color === undefined || token.color === "" ? null : token.color,
        italic: ((token.fontStyle ?? 0) & 1) !== 0,
        bold: ((token.fontStyle ?? 0) & 2) !== 0,
        underline: ((token.fontStyle ?? 0) & 4) !== 0,
      })),
    );
  }

  it("produces the same text and colours as codeToTokensBase for TypeScript", async () => {
    const source = [
      "// a comment",
      'const greeting: string = "hello";',
      "export function add(a: number, b: number): number {",
      "  return a + b; // trailing",
      "}",
      "",
      "const template = `value ${greeting} end`;",
    ].join("\n");

    const ours = await ourProjection(source, "typescript");
    const theirs = await shikiProjection(
      source,
      "typescript",
      (await import("@shikijs/langs/typescript")).default,
    );

    expect(ours).toEqual(theirs);
    // Not a vacuous match: several distinct theme variables really were used.
    expect(new Set(ours.flat().flatMap((t) => (t.color === null ? [] : [t.color]))).size)
      .toBeGreaterThan(2);
  }, 60_000);

  /**
   * CRLF, because the line SPLIT is now ours too.
   *
   * Driving the grammar directly means this module decides what a line is,
   * where `codeToTokensBase` used to decide it with `splitLines`. Those must
   * agree byte for byte or the viewer's rows stop corresponding to the file:
   * shiki splits on the capturing `/(\r?\n)/g` and keeps the even parts
   * (`@shikijs/primitive/dist/index.mjs:82-95`), which is `split(/\r?\n/)` -
   * the regex this folder already uses in `plainTokenize`, `projectLines` and
   * `countLines`. Read out of the package, and asserted here against the
   * package rather than trusted from the reading.
   */
  it("splits CRLF exactly as codeToTokensBase does", async () => {
    const source = "const a = 1;\r\n\r\nconst b = 2;\r\n";

    const ours = await ourProjection(source, "typescript");
    const theirs = await shikiProjection(
      source,
      "typescript",
      (await import("@shikijs/langs/typescript")).default,
    );

    expect(ours).toEqual(theirs);
    // No token carries a terminator, and the blank line is a blank line.
    expect(ours).toHaveLength(4);
    expect(ours[1]).toEqual([]);
    expect(ours.flat().every((token) => !token.text.includes("\r"))).toBe(true);
  }, 60_000);

  /**
   * MARKDOWN, because it is the only hot language whose theme emits a FONT
   * STYLE. `fontStyleOf` is the second copied bit accessor and the TypeScript
   * file above exercises none of it: under the css-variables theme every one of
   * its tokens comes back with no style bits at all, so a broken font-style
   * mask would pass that case unnoticed. `*emphasis*` is what the theme's
   * `{ scope: "emphasis", settings: { fontStyle: "italic" } }` rule reaches.
   */
  it("agrees about FONT STYLE too, which only markdown produces here", async () => {
    const source = ["# A heading", "", "Some *emphasis* in a paragraph."].join("\n");

    const ours = await ourProjection(source, "markdown");
    const theirs = await shikiProjection(
      source,
      "markdown",
      (await import("@shikijs/langs/markdown")).default,
    );

    expect(ours).toEqual(theirs);
    // The bit really was set, so the agreement above is about something.
    expect(ours.flat().some((token) => token.italic)).toBe(true);
  }, 60_000);
});

/**
 * THE RECONSTRUCTION RULE.
 *
 * A highlighter that drops or duplicates bytes would silently change what the
 * user reads, and a file viewer is the one surface where that is unacceptable:
 * the text on screen is evidence. The rule is asserted against hand-built token
 * streams because a real grammar will not misbehave on demand - and the defect
 * this guards against is precisely a future grammar or engine that does.
 */
describe("projectLines: the source line is the truth", () => {
  const token = (content: string): ThemedToken => ({ content, offset: 0 });

  /**
   * `projectLines` over hand-built lines that no line ran out of clock on.
   *
   * These cases are about reconstruction, cardinality and the token bound; the
   * budget report rides through them untouched and has its own cases above, so
   * spelling an empty one at every call site would be noise around the argument
   * each case is making.
   */
  function project(
    lines: readonly (readonly TokenizedToken[])[],
    text: string,
    maxLineLength: number,
    maxTokens: number,
  ): TokenizeOutcome {
    return projectLines(
      { lines, budgetExceededLines: [], budgetExceededTotal: 0 },
      text,
      maxLineLength,
      maxTokens,
    );
  }

  /** The successful lines, or a failure the caller did not expect. */
  function linesOf(outcome: TokenizeOutcome): readonly TokenLine[] {
    if (!outcome.ok) throw new Error(`projection refused: ${outcome.reason}`);
    return outcome.result.lines;
  }

  it("keeps the tokens when they reconstruct the line exactly", () => {
    const lines = linesOf(
      project([[token("const"), token(" a")]], "const a", 0, NO_TOKEN_BOUND),
    );
    expect(lines[0]?.map((entry) => entry.text)).toEqual(["const", " a"]);
  });

  it("falls back to ONE plain token when a byte was dropped", () => {
    // The tokens say "ac"; the file says "abc". Rendering the tokens would show
    // the user a line their file does not contain.
    const lines = linesOf(project([[token("a"), token("c")]], "abc", 0, NO_TOKEN_BOUND));
    expect(lines[0]).toEqual([
      { text: "abc", color: null, italic: false, bold: false, underline: false },
    ]);
  });

  it("falls back per LINE, leaving the good lines coloured", () => {
    const lines = linesOf(
      project([[token("ok")], [token("x")]], "ok\nbad", 0, NO_TOKEN_BOUND),
    );
    expect(lines[0]?.map((entry) => entry.text)).toEqual(["ok"]);
    expect(lines[1]).toEqual([
      { text: "bad", color: null, italic: false, bold: false, underline: false },
    ]);
  });

  it("matches shiki's own split, so CRLF text reconstructs unchanged", () => {
    // MEASURED against shiki 4.4.3: a `\r\n` file comes back with the `\r`
    // already stripped, which is why `split(/\r?\n/)` is the right comparison
    // and a CRLF file is not silently demoted to plain text.
    const lines = linesOf(
      project([[token("a")], [token("b")], []], "a\r\nb\r\n", 0, NO_TOKEN_BOUND),
    );
    expect(lines[0]?.[0]?.text).toBe("a");
    expect(lines[1]?.[0]?.text).toBe("b");
    expect(lines[2]).toEqual([]);
  });

  /**
   * CARDINALITY IS ALL-OR-NOTHING.
   *
   * A projection with a different number of lines than the source does not
   * correspond to the user's file line for line, and nothing can say which of
   * its lines map to which of theirs. Repairing it per line would put a file on
   * screen that is partly the tokenizer's invention and partly the user's, and
   * in the extra-lines direction it would PRESERVE content the file does not
   * contain. So the whole file falls back to plain, every line of it from the
   * source.
   */
  describe("a line-count mismatch is a whole-file plain fallback", () => {
    it("does not preserve a line the source does not have", () => {
      // Three tokenizer lines for a two-line file. The third is not in the file.
      const lines = linesOf(
        project(
          [[token("a")], [token("b")], [token("INVENTED")]],
          "a\nb",
          0,
          NO_TOKEN_BOUND,
        ),
      );
      expect(lines).toHaveLength(2);
      expect(lines.map((line) => line.map((entry) => entry.text).join(""))).toEqual([
        "a",
        "b",
      ]);
    });

    it("keeps every source line when the tokenizer emitted too few", () => {
      const lines = linesOf(project([[token("a")]], "a\nb", 0, NO_TOKEN_BOUND));
      expect(lines).toHaveLength(2);
      expect(lines[1]?.[0]?.text).toBe("b");
    });

    it("trusts NO line from a mismatched projection, not even one that matched", () => {
      // Line 0's tokens reconstruct "a" perfectly and carry a colour. Under a
      // mismatch it is still discarded: the count says these tokens are not a
      // description of this file, so no part of them is evidence about it.
      const coloured: ThemedToken = { content: "a", offset: 0, color: "var(--x)" };
      const lines = linesOf(
        project([[coloured], [token("b")], [token("c")]], "a\nb", 0, NO_TOKEN_BOUND),
      );
      expect(lines).toHaveLength(2);
      expect(lines[0]).toEqual([
        { text: "a", color: null, italic: false, bold: false, underline: false },
      ]);
    });
  });

  /**
   * THE TOKEN BOUND, refused where it can still save the work.
   *
   * The point of enforcing it here rather than in the renderer is that the
   * oversized array is abandoned rather than finished: nothing over the bound is
   * ever returned, so nothing over the bound is ever structured-cloned across
   * the worker boundary.
   */
  describe("the token bound", () => {
    it("refuses a projection over the bound rather than returning it", () => {
      const outcome = project(
        [[token("a"), token("b"), token("c")]],
        "abc",
        0,
        2,
      );
      expect(outcome).toEqual({ ok: false, reason: "too_many_tokens" });
    });

    it("allows a projection exactly AT the bound", () => {
      const outcome = project([[token("a"), token("b")]], "ab", 0, 2);
      expect(outcome.ok).toBe(true);
    });

    it("applies to the plain fallback too, where one token per line still counts", () => {
      // Four source lines, so four plain tokens, against a bound of three - and
      // the mismatch sends it down the plain path first.
      const outcome = project([[token("a")]], "a\nb\nc\nd", 0, 3);
      expect(outcome).toEqual({ ok: false, reason: "too_many_tokens" });
    });
  });
});
