/**
 * THE SHIKI TOKENIZER - pure, lib-neutral, and the only module that knows
 * shiki exists.
 *
 * It touches no DOM and no worker API, so it compiles under both
 * `tsconfig.renderer.json` and `tsconfig.renderer-worker.json` and can be
 * tested directly, with the real library, in the ordinary renderer suite. The
 * worker around it (`highlight.worker.ts`) is then thin enough to read in one
 * screen, which is the point of the split.
 *
 * ## Two owners, one product
 *
 * This is the STUDIO's highlighter and it is not the chat transcript's. The
 * transcript keeps its small synchronous tokenizer in
 * `lib/markdown/highlight.ts` because a snippet arriving in a streaming
 * transcript has to paint in the same frame. A whole file in an arbitrary
 * language needs real grammars, and it can afford a worker round trip because
 * it appears once when a tab opens. Different policies, different owners; the
 * header of `lib/markdown/highlight.ts` names both.
 *
 * ## The theme is CSS variables, so the colours are ours
 *
 * `createCssVariablesTheme` makes every token colour a `var(...)` reference
 * rather than a hex literal, which is what lets one tokenization serve both
 * themes: the light and dark values live in `tokens.css` beside every other
 * alias, the theme switch repoints them, and nothing is re-tokenized. It also
 * means no colour decision reaches this file, which is exactly where a colour
 * decision does not belong.
 *
 * ## `forgiving: false` is a REPORTING choice
 *
 * The JavaScript regex engine converts Oniguruma patterns to native RegExp and
 * cannot express all of them. `forgiving: true` would SKIP an unconvertible
 * pattern and tokenize on with a quietly wrong grammar - a file that looks
 * highlighted and is subtly lying. `false` raises instead, the failure becomes
 * a `tokenize_failed` code, and the viewer shows honest plain text with the
 * reason on the chip.
 *
 * MEASURED against the installed shiki 4.4.3, because this contradicts the
 * obvious reading of the API doc: the conversion error surfaces during
 * TOKENIZATION, not during `loadLanguage`. vscode-textmate compiles a rule's
 * scanner lazily on first use, so a grammar with an unsupported pattern loads
 * cleanly and throws on the first line that reaches that rule. `loadLanguage`
 * failures are therefore about the MODULE (a failed dynamic import), and both
 * paths are caught below and mapped to their own code.
 *
 * ## Every line is CHECKED against the source it came from
 *
 * A highlighter that drops or duplicates bytes would silently change what the
 * user reads, and a viewer is the one surface where that is unacceptable: the
 * file on screen is evidence. So each projected line's token texts are
 * concatenated and compared with the source line, and a line that does not
 * reconstruct falls back to ONE plain token carrying the source text - the
 * colour is lost for that line, the bytes never are.
 *
 * The comparison is sound because shiki splits lines exactly as
 * `text.split(/\r?\n/)` does. MEASURED against the installed shiki 4.4.3
 * rather than assumed: `"const a = 1;\nconst b = 2;\n"` and the same text with
 * `\r\n` both produce three lines whose token texts carry no terminator and no
 * `\r`.
 *
 * ## The long-line rule is shiki's own, and it is VS Code's value
 *
 * `tokenizeMaxLineLength` is a first-class shiki option: a line at or above it
 * is emitted as one token with an empty colour, tokenized by nobody. That is
 * precisely VS Code's `editor.maxTokenizationLineLength` behaviour, so there
 * is no hand-rolled line splitting here - only the COUNT, which shiki does not
 * report and the viewer must show.
 */

import {
  createCssVariablesTheme,
  createHighlighterCore,
  type HighlighterCore,
} from "@shikijs/core";
import { createJavaScriptRegexEngine } from "@shikijs/engine-javascript";
import type { LanguageRegistration, ThemedToken } from "@shikijs/types";
import type { HighlightToken, TokenizeResult, TokenLine } from "./highlight-protocol.js";
import { HOT_LANGUAGES, PLAIN_LANGUAGE, type HotLanguageId } from "./language-of-path.js";

/**
 * The theme's name inside shiki's registry. Never user-visible.
 */
const THEME_NAME = "vex";

/**
 * The CSS custom-property prefix the theme emits.
 *
 * It matches the `--vex-alias-code-*` family declared in BOTH theme blocks of
 * `styles/global-css/tokens.css`. The two are a CONTRACT: shiki writes
 * `var(--vex-alias-code-token-keyword)` into a token's colour, and if the
 * stylesheet stops declaring that name the token renders with no colour at
 * all - no error, no warning, just grey code. `theme-matrix.test.ts` pins
 * every slot in both themes so that cannot ship.
 */
export const CODE_VARIABLE_PREFIX = "--vex-alias-code-";

/**
 * Every slot `createCssVariablesTheme` can emit for a non-ANSI language, read
 * out of the installed `@shikijs/core/dist/index.mjs` rather than remembered.
 *
 * The ANSI slots (`ansi-black` and the fifteen others) are deliberately absent:
 * shiki emits those only through `tokenizeAnsiWithTheme`, which is reached only
 * by the special `ansi` language id. That id is not in the hot set and this
 * tokenizer never asks for it, so declaring sixteen more custom properties
 * would be declaring colours nothing can produce. Named here so the omission is
 * a decision on the record rather than a gap.
 */
export const CODE_THEME_SLOTS = [
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
] as const;

/**
 * TextMate font-style bit flags, from `@shikijs/vscode-textmate`'s `FontStyle`.
 *
 * Copied as literals on purpose: the upstream declaration is a `const enum`,
 * which `isolatedModules` forbids importing as a value. Three integers with
 * their source named beat a build-breaking import.
 */
const FONT_STYLE_ITALIC = 1;
const FONT_STYLE_BOLD = 2;
const FONT_STYLE_UNDERLINE = 4;

/**
 * How a grammar module is fetched, keyed by language id.
 *
 * Every specifier is a STRING LITERAL. A computed specifier
 * (`import(\`@shikijs/langs/${id}\`)`) would make the bundler emit all 361
 * grammars as reachable chunks, which is exactly the megabyte problem the hot
 * set exists to avoid, and it would let any id reach the module graph. This
 * table is the bound, and it is enforced by construction: an id with no entry
 * cannot be loaded.
 *
 * Each module default-exports an ARRAY of registrations holding the language
 * AND its embedded ones - `html` spreads in `javascript` and `css` - so the
 * "load the embedded languages for each parent" obligation in
 * `LanguageRegistration`'s doc is already discharged by the module itself.
 *
 * Markdown is the documented exception: its fenced-code languages are
 * `embeddedLangsLazy`, which shiki does NOT load automatically. A fenced block
 * inside a markdown file therefore renders in markdown's own string colour
 * rather than in its own language. That is a bounded, honest result; loading
 * markdown's 40 lazy languages would pull most of the bundle back in.
 */
type GrammarLoader = () => Promise<{ readonly default: LanguageRegistration[] }>;

const GRAMMAR_LOADERS: Readonly<Record<HotLanguageId, GrammarLoader>> = {
  typescript: () => import("@shikijs/langs/typescript"),
  tsx: () => import("@shikijs/langs/tsx"),
  javascript: () => import("@shikijs/langs/javascript"),
  jsx: () => import("@shikijs/langs/jsx"),
  json: () => import("@shikijs/langs/json"),
  jsonc: () => import("@shikijs/langs/jsonc"),
  markdown: () => import("@shikijs/langs/markdown"),
  python: () => import("@shikijs/langs/python"),
  rust: () => import("@shikijs/langs/rust"),
  go: () => import("@shikijs/langs/go"),
  yaml: () => import("@shikijs/langs/yaml"),
  toml: () => import("@shikijs/langs/toml"),
  css: () => import("@shikijs/langs/css"),
  html: () => import("@shikijs/langs/html"),
  shellscript: () => import("@shikijs/langs/shellscript"),
  sql: () => import("@shikijs/langs/sql"),
  solidity: () => import("@shikijs/langs/solidity"),
};

/** The tokenizer's outcome. A refusal is an ANSWER, never a thrown error. */
export type TokenizeOutcome =
  | { readonly ok: true; readonly result: TokenizeResult }
  | { readonly ok: false; readonly reason: "grammar_unavailable" | "tokenize_failed" };

export interface ShikiTokenizer {
  /**
   * Tokenize a whole file. Resolves with an outcome; never rejects.
   *
   * @param text the WHOLE file
   * @param language a hot-set id or {@link PLAIN_LANGUAGE}
   * @param maxLineLength lines at or above this length are emitted plain and
   *   counted in `longLines`
   */
  tokenize(text: string, language: string, maxLineLength: number): Promise<TokenizeOutcome>;
  /** Release the highlighter. Idempotent. */
  dispose(): void;
}

export interface TokenizerOptions {
  /**
   * Grammar loaders, injected so a test can prove the rejecting-loader path
   * without breaking a real grammar on disk. Production passes nothing.
   */
  readonly loaders?: Readonly<Partial<Record<string, GrammarLoader>>>;
}

/**
 * Build the tokenizer.
 *
 * The highlighter core is created LAZILY, on the first tokenize that needs a
 * grammar, and then kept: constructing it evaluates the theme and stands up
 * the regex engine, and a viewer opened on a plain-text file should pay
 * neither. Plain text never touches it at all.
 */
export function createTokenizer(options: TokenizerOptions = {}): ShikiTokenizer {
  const loaders: Readonly<Partial<Record<string, GrammarLoader>>> =
    options.loaders ?? GRAMMAR_LOADERS;

  let core: HighlighterCore | null = null;
  /**
   * The in-flight creation, so two tokenize calls that arrive together join one
   * highlighter instead of building two. Shiki warns about multiple instances
   * for a reason: each one holds its own compiled grammars.
   */
  let creating: Promise<HighlighterCore> | null = null;
  /** Grammar ids whose load has been started, so a second file does not re-import. */
  const loading = new Map<string, Promise<void>>();
  let disposed = false;

  async function highlighter(): Promise<HighlighterCore> {
    if (core !== null) return core;
    if (creating !== null) return creating;
    const theme = createCssVariablesTheme({
      name: THEME_NAME,
      variablePrefix: CODE_VARIABLE_PREFIX,
      // Kept ON: italic comments and bold headings are carried through as
      // classes by the renderer, and switching it off would silently discard
      // the only non-colour signal markdown has.
      fontStyle: true,
    });
    const pending = createHighlighterCore({
      engine: createJavaScriptRegexEngine({ forgiving: false }),
      themes: [theme],
      // No grammar up front. Every one arrives through `GRAMMAR_LOADERS`, on
      // demand, for the file actually open.
      langs: [],
    }).then((created) => {
      core = created;
      creating = null;
      return created;
    });
    creating = pending;
    return pending;
  }

  /**
   * Ensure a grammar is registered. Single-flight per id.
   *
   * `getLoadedLanguages()` reports ALIASES as well as canonical ids (loading
   * `shellscript` reports `bash`, `sh`, `shell`, `zsh`), so the membership test
   * is correct for an alias the caller might pass even though our own table
   * only ever passes canonical ids.
   */
  async function ensureGrammar(instance: HighlighterCore, language: string): Promise<void> {
    if (instance.getLoadedLanguages().includes(language)) return;
    const existing = loading.get(language);
    if (existing !== undefined) {
      await existing;
      return;
    }
    const loader = loaders[language];
    if (loader === undefined) throw new GrammarUnavailable(language);
    const load = loader()
      .then(async (module) => {
        await instance.loadLanguage(module.default);
      })
      .catch((cause: unknown) => {
        // Not cached as a rejection: a second file in the same language should
        // get a fresh attempt rather than inherit a transient chunk-load
        // failure forever.
        loading.delete(language);
        throw new GrammarUnavailable(language, cause);
      });
    loading.set(language, load);
    await load;
  }

  return {
    async tokenize(text, language, maxLineLength) {
      if (disposed) return { ok: false, reason: "tokenize_failed" };

      // PLAIN TEXT never builds a highlighter and never loads a grammar. Shiki
      // would answer this correctly too, but paying for the engine to be told
      // "no grammar" is work with no product behind it.
      if (language === PLAIN_LANGUAGE) {
        return { ok: true, result: plainTokenize(text, maxLineLength) };
      }

      let instance: HighlighterCore;
      try {
        instance = await highlighter();
        await ensureGrammar(instance, language);
      } catch (cause: unknown) {
        warn(`grammar for ${language} is unavailable`, cause);
        return { ok: false, reason: "grammar_unavailable" };
      }

      // A dispose that landed during the two awaits above: the highlighter is
      // gone and tokenizing through it would throw on a freed registry.
      if (disposed) return { ok: false, reason: "tokenize_failed" };

      try {
        const lines = instance.codeToTokensBase(text, {
          lang: language,
          theme: THEME_NAME,
          tokenizeMaxLineLength: maxLineLength,
        });
        return { ok: true, result: projectLines(lines, text, maxLineLength) };
      } catch (cause: unknown) {
        warn(`tokenizing ${language} failed`, cause);
        return { ok: false, reason: "tokenize_failed" };
      }
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      loading.clear();
      const instance = core;
      core = null;
      creating = null;
      instance?.dispose();
    },
  };
}

/**
 * The grammar module could not be obtained. Carries the cause for the log and
 * nothing for the wire.
 */
class GrammarUnavailable extends Error {
  constructor(language: string, cause?: unknown) {
    super(`no grammar for ${language}`, cause === undefined ? undefined : { cause });
    this.name = "GrammarUnavailable";
  }
}

/**
 * Log a failure where it happened, with its real cause.
 *
 * The sentence stays here; only the CODE crosses the wire. Rule 04's error
 * layers: the infrastructure failure keeps its cause, the trusted UI gets a
 * sanitized reason.
 */
function warn(message: string, cause: unknown): void {
  console.warn(`studio viewer highlight: ${message}`, cause);
}

/**
 * Split plain text into one uncoloured token per line.
 *
 * Deliberately NOT delegated to shiki: this is the path a file with no grammar
 * takes, and it must not depend on an engine being constructible. It matches
 * shiki's own plain-language output (one token per line, no colour) and applies
 * the same long-line accounting, so the two paths are indistinguishable to the
 * viewer.
 *
 * `\r\n` and `\n` both terminate a line and the terminator is not part of the
 * token; a lone `\r` is not a line break, matching shiki's `RE_NEWLINE`.
 *
 * EXPORTED because the viewer session needs the same split for a file it is
 * showing without colour (no grammar, over the byte bound, a dead worker). One
 * definition of "what a line is" for both paths: two would eventually disagree
 * about a trailing `\r\n` and the viewer would show a different line count
 * depending on why it was not highlighted.
 */
export function plainTokenize(text: string, maxLineLength: number): TokenizeResult {
  const lines: TokenLine[] = [];
  let longLines = 0;
  for (const raw of text.split(/\r?\n/)) {
    if (isOverLength(raw.length, maxLineLength)) longLines += 1;
    lines.push(raw.length === 0 ? [] : [plainToken(raw)]);
  }
  return { lines, longLines };
}

/**
 * Shiki's own bound, restated so the count matches the behaviour EXACTLY.
 *
 * `@shikijs/primitive` compares `line.length >= tokenizeMaxLineLength`, and a
 * `maxLineLength` of 0 or less disables the bound entirely. Getting the
 * comparison wrong by one would make the viewer report a long-line count that
 * disagrees with what it renders.
 */
function isOverLength(length: number, maxLineLength: number): boolean {
  return maxLineLength > 0 && length >= maxLineLength;
}

function plainToken(text: string): HighlightToken {
  return { text, color: null, italic: false, bold: false, underline: false };
}

/**
 * Project shiki's tokens onto the wire shape and count the long lines.
 *
 * A line that shiki skipped for length comes back as EXACTLY ONE token whose
 * colour is the empty string. That is the marker, but it is not what is
 * counted: the length test is applied to the line's own text, so the count
 * stays right even if a future shiki spells "skipped" differently.
 *
 * Two spellings of "no colour" are normalised to `null` here - an absent
 * property (plain-language lines) and an empty string (over-length lines) - so
 * the renderer has one case.
 */
/**
 * Exported for its COLOCATED test only, which drives the reconstruction rule
 * with token streams a real grammar will not produce on demand. It is a pure
 * function over its arguments; nothing outside this folder imports it.
 */
export function projectLines(
  lines: readonly (readonly ThemedToken[])[],
  text: string,
  maxLineLength: number,
): TokenizeResult {
  const sourceLines = text.split(/\r?\n/);
  const projected: TokenLine[] = [];
  let longLines = 0;
  let unreconstructed = 0;

  for (const [index, line] of lines.entries()) {
    let rendered = "";
    const tokens: HighlightToken[] = [];
    for (const token of line) {
      rendered += token.content;
      const style = token.fontStyle ?? 0;
      tokens.push({
        text: token.content,
        color: token.color === undefined || token.color === "" ? null : token.color,
        italic: (style & FONT_STYLE_ITALIC) !== 0,
        bold: (style & FONT_STYLE_BOLD) !== 0,
        underline: (style & FONT_STYLE_UNDERLINE) !== 0,
      });
    }
    if (isOverLength(rendered.length, maxLineLength)) longLines += 1;

    // THE RECONSTRUCTION CHECK. The source line is the truth; the tokens are a
    // decoration over it, and a decoration that changed the text is discarded
    // rather than shown.
    const source = sourceLines[index];
    if (source === undefined || source !== rendered) {
      unreconstructed += 1;
      const repaired = source ?? rendered;
      projected.push(repaired.length === 0 ? [] : [plainToken(repaired)]);
      continue;
    }
    projected.push(tokens);
  }

  // A line shiki never emitted is a line the user would not see at all, so the
  // remainder of the source is carried through plain rather than dropped.
  for (let index = lines.length; index < sourceLines.length; index += 1) {
    const source = sourceLines[index] ?? "";
    unreconstructed += 1;
    projected.push(source.length === 0 ? [] : [plainToken(source)]);
  }

  if (unreconstructed > 0) {
    warn(
      `${String(unreconstructed)} line(s) did not reconstruct and were shown plain`,
      null,
    );
  }

  return { lines: projected, longLines };
}

/**
 * Every hot language has a loader.
 *
 * Exported so the test can assert the two tables in this folder stay in step
 * rather than drifting into a language the viewer offers and cannot load.
 */
export function hotLanguagesWithoutLoader(): readonly string[] {
  return HOT_LANGUAGES.filter((id) => GRAMMAR_LOADERS[id] === undefined);
}
