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
  projectLines,
} from "../shiki-tokenizer.js";
import { HOT_LANGUAGES, PLAIN_LANGUAGE } from "../language-of-path.js";
import type { ThemedToken } from "@shikijs/types";
import type { TokenizeResult } from "../highlight-protocol.js";

const NO_LINE_BOUND = 0;

function flatten(result: TokenizeResult): string {
  return result.lines.map((line) => line.map((token) => token.text).join("")).join("\n");
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
    const tokenizer = createTokenizer();
    const source = 'const greeting = "hello";\n';
    const outcome = await tokenizer.tokenize(source, "typescript", NO_LINE_BOUND);
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

  it("answers plain text with one uncoloured token per line", async () => {
    const tokenizer = createTokenizer();
    const outcome = await tokenizer.tokenize(
      "alpha\nbeta\n\ngamma",
      PLAIN_LANGUAGE,
      NO_LINE_BOUND,
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
    const outcome = await tokenizer.tokenize(source, "typescript", 100);
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
    const outcome = await tokenizer.tokenize(`${"z".repeat(50)}\nshort`, PLAIN_LANGUAGE, 10);
    tokenizer.dispose();
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.longLines).toBe(1);
  });

  it("answers grammar_unavailable for a language outside the hot set", async () => {
    const tokenizer = createTokenizer();
    const outcome = await tokenizer.tokenize("SELECT 1", "cobol", NO_LINE_BOUND);
    tokenizer.dispose();
    expect(outcome).toEqual({ ok: false, reason: "grammar_unavailable" });
  });

  it("answers grammar_unavailable when a loader REJECTS, and does not throw", async () => {
    const tokenizer = createTokenizer({
      loaders: {
        typescript: () => Promise.reject(new Error("chunk load failed")),
      },
    });
    const outcome = await tokenizer.tokenize("const a = 1;", "typescript", NO_LINE_BOUND);
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

    expect(await tokenizer.tokenize("const a = 1;", "typescript", NO_LINE_BOUND)).toEqual({
      ok: false,
      reason: "grammar_unavailable",
    });
    const second = await tokenizer.tokenize("const a = 1;", "typescript", NO_LINE_BOUND);
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

    const outcome = await tokenizer.tokenize(source, "typescript", 20_000);
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
      );
      if (!outcome.ok) failures.push(`${language}: ${outcome.reason}`);
    }
    tokenizer.dispose();
    expect(failures).toEqual([]);
  }, 60_000);

  it("stops answering after dispose", async () => {
    const tokenizer = createTokenizer();
    tokenizer.dispose();
    expect(await tokenizer.tokenize("const a = 1;", "typescript", NO_LINE_BOUND)).toEqual({
      ok: false,
      reason: "tokenize_failed",
    });
  });
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

  it("keeps the tokens when they reconstruct the line exactly", () => {
    const { lines } = projectLines([[token("const"), token(" a")]], "const a", 0);
    expect(lines[0]?.map((entry) => entry.text)).toEqual(["const", " a"]);
  });

  it("falls back to ONE plain token when a byte was dropped", () => {
    // The tokens say "ac"; the file says "abc". Rendering the tokens would show
    // the user a line their file does not contain.
    const { lines } = projectLines([[token("a"), token("c")]], "abc", 0);
    expect(lines[0]).toEqual([
      { text: "abc", color: null, italic: false, bold: false, underline: false },
    ]);
  });

  it("falls back per LINE, leaving the good lines coloured", () => {
    const { lines } = projectLines(
      [[token("ok")], [token("x")]],
      "ok\nbad",
      0,
    );
    expect(lines[0]?.map((entry) => entry.text)).toEqual(["ok"]);
    expect(lines[1]).toEqual([
      { text: "bad", color: null, italic: false, bold: false, underline: false },
    ]);
  });

  it("carries through a line the tokenizer never emitted", () => {
    const { lines } = projectLines([[token("a")]], "a\nb", 0);
    expect(lines).toHaveLength(2);
    expect(lines[1]?.[0]?.text).toBe("b");
  });

  it("matches shiki's own split, so CRLF text reconstructs unchanged", () => {
    // MEASURED against shiki 4.4.3: a `\r\n` file comes back with the `\r`
    // already stripped, which is why `split(/\r?\n/)` is the right comparison
    // and a CRLF file is not silently demoted to plain text.
    const { lines } = projectLines([[token("a")], [token("b")], []], "a\r\nb\r\n", 0);
    expect(lines[0]?.[0]?.text).toBe("a");
    expect(lines[1]?.[0]?.text).toBe("b");
    expect(lines[2]).toEqual([]);
  });
});
