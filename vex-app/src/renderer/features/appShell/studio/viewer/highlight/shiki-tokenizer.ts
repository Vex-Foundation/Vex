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
 *
 * ## The per-line WALL-CLOCK budget is stated here, not inherited silently
 *
 * vscode-textmate stops scanning a line once `Date.now()` says it has spent
 * longer than `tokenizeTimeLimit` on it, and returns what it has: the rest of
 * the line arrives as one token carrying the scope the scanner was in when the
 * clock ran out. Byte-exact, and quietly under-coloured. MEASURED in the
 * installed packages rather than assumed:
 * `@shikijs/primitive/dist/index.mjs:620` defaults the option to 500 and hands
 * it to `grammar.tokenizeLine2` at :654; `@shikijs/vscode-textmate/dist/
 * index.js:1794-1822` is the `Date.now()` loop guard that abandons the line and
 * returns `new TokenizeStringResult(stack, true)`.
 *
 * That default is inherited by whoever calls `codeToTokensBase` without saying
 * otherwise, which makes every colour this module produces a function of how
 * busy the machine was. {@link LINE_TIME_BUDGET_MS} names the value we adopt
 * and {@link TokenizerOptions.lineTimeBudgetMs} lets a caller who needs a
 * deterministic tokenization ask for one, so the budget is a policy on the
 * record instead of a library default nobody wrote down.
 *
 * ## WHY THIS MODULE DRIVES THE GRAMMAR ITSELF INSTEAD OF `codeToTokensBase`
 *
 * The budget being a stated policy was only half the problem. The other half is
 * that a line it abandons is INDISTINGUISHABLE, in shiki's output, from a line
 * that finished: `grammar.tokenizeLine2` returns
 * `{ tokens, ruleStack, stoppedEarly }`
 * (`@shikijs/vscode-textmate/dist/index.js:2438-2445`, the flag itself built at
 * :1788-1822), and shiki's `_tokenizeWithTheme` reads only `result.tokens` and
 * `result.ruleStack` (`@shikijs/primitive/dist/index.mjs:618-711`, the drop at
 * :654 and :705). `codeToTokensBase` therefore CANNOT report it, and the viewer
 * used to show a half-coloured line as a fully highlighted one.
 *
 * A token-coverage check over shiki's output cannot recover the fact either,
 * and this was MEASURED rather than assumed: `getBinaryResult(ruleStack,
 * lineLength)` closes the last token at the line's end, so an abandoned line is
 * covered edge to edge exactly like a finished one. The only signal left is "the
 * last token is suspiciously long", which a long string literal, a base64 blob
 * or a minified tail produces with no clock involved. `shiki-tokenizer.test.ts`
 * pins that: on a line the budget abandoned, the tokens still concatenate to the
 * whole line.
 *
 * So the flag has to come from the grammar, and shiki hands the grammar over:
 * `HighlighterCore` extends `ShikiPrimitive`, whose `getLanguage(name): Grammar`
 * and `setTheme(name): { theme, colorMap }` are public
 * (`@shikijs/types/dist/index.d.mts:782` and :787). {@link tokenizeThroughGrammar}
 * drives them line by line and keeps `stoppedEarly`.
 *
 * This is VS CODE'S OWN SEAM, not an invention: `agents-colab/vscode/src/vs/
 * workbench/services/textMate/browser/tokenizationSupport/
 * textMateTokenizationSupport.ts:53` calls `this._grammar.tokenizeLine2(line,
 * state, 500)` directly and branches on `stoppedEarly` at :61-65, keeping the
 * partial tokens on screen. We keep them too, which is deliverable and rule
 * both: the colours found before the clock ran out are real colours.
 *
 * ## AN ABANDONED LINE DOES NOT COLOUR THE NEXT ONE
 *
 * VS Code's second rule, adopted here: on `stoppedEarly` it keeps the partial
 * tokens AND returns the state from the START of the line
 * (`textMateTokenizationSupport.ts:62-66`, "return the state at the beginning of
 * the line"), so a following line is never coloured from a rule stack the
 * scanner did not finish walking. Shiki propagates `result.ruleStack`
 * unconditionally; this module does not.
 *
 * The reason is that the half-walked stack is not a fact about the FILE, it is a
 * fact about where a wall clock happened to stop. A line beginning with a
 * backtick, abandoned after its first match, hands the next line a stack that
 * says "inside a template literal" - and the rest of the file goes string-
 * coloured because a machine was busy for a millisecond. Under the pre-line
 * state the damage stops at the line the clock actually hit: that line keeps the
 * colours found before the budget ran out, and the file after it is coloured by
 * the grammar alone. Both policies are guesses about an unfinished scan; only
 * one of them is bounded to the line it happened on.
 *
 * MEASURED, not reasoned: `shiki-tokenizer.test.ts` builds exactly that file and
 * pins both sides. Under the propagating policy the line after the abandoned one
 * arrives as a single `token-string-expression` run; under this one it is
 * `const` in the keyword colour with no string colour anywhere on it. The same
 * file with the clock OFF is string-coloured under both, because nothing was
 * abandoned - which is the other half of the contract: this changes NOTHING on
 * the path where the scan finished.
 *
 * The budget report is untouched by any of it: an abandoned line is still
 * counted and still listed, because what the chip reports is that the clock ran
 * out, not what was done about the state afterwards.
 */

import {
  applyColorReplacements,
  createCssVariablesTheme,
  createHighlighterCore,
  resolveColorReplacements,
  type HighlighterCore,
} from "@shikijs/core";
import { createJavaScriptRegexEngine } from "@shikijs/engine-javascript";
import type { LanguageRegistration } from "@shikijs/types";
import type { StateStack } from "@shikijs/vscode-textmate";
import {
  HIGHLIGHT_BUDGET_LINES_LISTED,
  type HighlightToken,
  type TokenizeResult,
  type TokenLine,
} from "./highlight-protocol.js";
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
 * How a binary token's 32 bits carry its colour and its font style.
 *
 * `tokenizeLine2` returns a `Uint32Array` of `[startIndex, metadata]` pairs, and
 * these two accessors are what turn the metadata half into the fields
 * {@link projectLines} reads. Read out of the installed
 * `@shikijs/vscode-textmate/dist/index.js:592-628` (`EncodedTokenMetadata`,
 * `FONT_STYLE_MASK` 30720 at offset 11, `FOREGROUND_MASK` 16744448 at offset
 * 15), and copied as literals for the same reason the font-style flags above
 * are: the upstream masks are `const enum` members, which `isolatedModules`
 * forbids importing as values. The package is a declared dependency now (the
 * `StateStack` import below), so the declaration is no longer the obstacle - the
 * `const enum` still is.
 *
 * The layout is not trusted on the strength of that reading. The colocated
 * suite tokenizes real files through BOTH this path and shiki's own
 * `codeToTokensBase` and asserts the projections are identical, so a mask that
 * drifted in a shiki upgrade turns every colour wrong and the suite red, which
 * is the only assertion about bit fields that is worth anything.
 */
const FOREGROUND_MASK = 16_744_448;
const FOREGROUND_OFFSET = 15;
const FONT_STYLE_MASK = 30_720;
const FONT_STYLE_OFFSET = 11;

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

/**
 * How long tokenizing ONE line may take before vscode-textmate abandons the
 * rest of it, in milliseconds. Zero disables the clock entirely.
 *
 * 500 is shiki's own default, kept deliberately: it is the guard that stops a
 * pathological grammar-and-line pair from freezing the highlight worker, and a
 * viewer that paints a file once per tab can afford half a second a line. The
 * value is written down here so raising or removing it is a decision someone
 * makes, and so the only place that spends this budget is visible in one grep.
 */
export const LINE_TIME_BUDGET_MS = 500;

/** The tokenizer's outcome. A refusal is an ANSWER, never a thrown error. */
export type TokenizeOutcome =
  | { readonly ok: true; readonly result: TokenizeResult }
  | {
      readonly ok: false;
      readonly reason: "grammar_unavailable" | "tokenize_failed" | "too_many_tokens";
    };

export interface ShikiTokenizer {
  /**
   * Tokenize a whole file. Resolves with an outcome; never rejects.
   *
   * @param text the WHOLE file
   * @param language a hot-set id or {@link PLAIN_LANGUAGE}
   * @param maxLineLength lines at or above this length are emitted plain and
   *   counted in `longLines`
   * @param maxTokens the whole-file bound. Zero or less disables it. Enforced
   *   WHILE projecting, so an oversized graph is abandoned rather than built
   *   and handed to the caller to reject.
   */
  tokenize(
    text: string,
    language: string,
    maxLineLength: number,
    maxTokens: number,
  ): Promise<TokenizeOutcome>;
  /** Release the highlighter. Idempotent. */
  dispose(): void;
}

export interface TokenizerOptions {
  /**
   * Grammar loaders, injected so a test can prove the rejecting-loader path
   * without breaking a real grammar on disk. Production passes nothing.
   */
  readonly loaders?: Readonly<Partial<Record<string, GrammarLoader>>>;
  /**
   * The per-line wall-clock budget, in milliseconds. Defaults to
   * {@link LINE_TIME_BUDGET_MS}; zero disables the clock.
   *
   * Injected because the budget makes a token's COLOUR depend on the machine's
   * load: a line that runs out of clock keeps its bytes and loses the rest of
   * its colours, with nothing said about it. A caller that asserts on colours -
   * the colocated suite does - asks for zero and gets a tokenization that is a
   * function of the grammar alone.
   */
  readonly lineTimeBudgetMs?: number;
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
  const lineTimeBudgetMs = options.lineTimeBudgetMs ?? LINE_TIME_BUDGET_MS;

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
    async tokenize(text, language, maxLineLength, maxTokens) {
      if (disposed) return { ok: false, reason: "tokenize_failed" };

      // PLAIN TEXT never builds a highlighter and never loads a grammar. Shiki
      // would answer this correctly too, but paying for the engine to be told
      // "no grammar" is work with no product behind it.
      if (language === PLAIN_LANGUAGE) {
        return boundedPlain(text, maxLineLength, maxTokens);
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
        const tokenized = tokenizeThroughGrammar(
          instance,
          text,
          language,
          maxLineLength,
          lineTimeBudgetMs,
        );
        return projectLines(tokenized, text, maxLineLength, maxTokens);
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

/* ------------------------------------------------------------------ *
 * Driving the grammar
 * ------------------------------------------------------------------ */

/**
 * The per-line rule stack the grammar threads from one line to the next.
 *
 * Named through its own package now that `@shikijs/vscode-textmate` is a
 * DECLARED dependency of this app (10.0.2, MIT, shiki's own fork of Microsoft's
 * `vscode-textmate`, and already the exact copy shiki 4.4.3 resolves): the type
 * this loop threads is the one thing about this library the module states in its
 * own signature, and a structural derivation through
 * `ReturnType<...>["ruleStack"]` said the same thing while hiding where it came
 * from. The import is TYPE-ONLY - no runtime edge is added, and the masks and
 * font-style flags above stay copied literals because those are `const enum`
 * members that `isolatedModules` still forbids importing as values.
 */
type LineState = StateStack;

/**
 * One styled run as the grammar produced it, before the wire shape.
 *
 * Deliberately the THREE fields {@link projectLines} reads and no more. Shiki's
 * `ThemedToken` also carries an `offset` into the file and an optional
 * `explanation`; neither reaches the viewer, and computing an offset we would
 * never read is an invariant to get wrong for nothing.
 */
export interface TokenizedToken {
  readonly content: string;
  /** Empty string is shiki's own "no colour", normalised to `null` later. */
  readonly color?: string;
  /** TextMate font-style bits. Absent means none. */
  readonly fontStyle?: number;
}

/** A whole file, tokenized, with the per-line clock's verdict on each line. */
export interface TokenizedLines {
  readonly lines: readonly (readonly TokenizedToken[])[];
  /** 1-based, ascending, at most {@link HIGHLIGHT_BUDGET_LINES_LISTED} entries. */
  readonly budgetExceededLines: readonly number[];
  /** Exact. Above the array's length means the rest were not listed. */
  readonly budgetExceededTotal: number;
}

/**
 * Tokenize a whole file line by line, THROUGH the grammar, keeping the flag
 * shiki drops.
 *
 * This is `@shikijs/primitive`'s `_tokenizeWithTheme` reproduced over the
 * options this module actually passes - no `includeExplanation`, no
 * `grammarState`, no `grammarContextCode`, no offsets - plus the one thing that
 * function cannot return: WHICH lines vscode-textmate abandoned. See the module
 * header for why the flag cannot be recovered any other way.
 *
 * Every rule it reproduces is reproduced deliberately, and each is the source of
 * a defect if it drifts:
 *
 *  - an EMPTY line is an empty array, never a call into the grammar;
 *  - a line at or above `maxLineLength` is one token whose colour is the empty
 *    string, tokenized by nobody. `isOverLength` is the same comparison
 *    `plainTokenize` and `projectLines` use, so the three agree about which
 *    lines are long by construction;
 *  - the rule stack CARRIES across both of those, so a template literal opened
 *    before a blank line is still open after it;
 *  - a zero-width token is skipped, which is what keeps a run of them from
 *    becoming empty spans in the DOM.
 *
 * The line split is this folder's ONE definition (`/\r?\n/`), shared with
 * `plainTokenize`, `projectLines` and `countLines` on the wire, so the count the
 * port checks and the count produced here cannot disagree.
 */
function tokenizeThroughGrammar(
  instance: HighlighterCore,
  text: string,
  language: string,
  maxLineLength: number,
  lineTimeBudgetMs: number,
): TokenizedLines {
  const { theme, colorMap } = instance.setTheme(THEME_NAME);
  const grammar = instance.getLanguage(language);
  // Shiki's own resolution, called rather than assumed: the css-variables theme
  // declares no replacements today, and asking the library keeps that a fact
  // about the theme instead of a guess baked into this loop.
  const replacements = resolveColorReplacements(theme, {});

  const lines: TokenizedToken[][] = [];
  const budgetExceededLines: number[] = [];
  let budgetExceededTotal = 0;
  let state: LineState | null = null;

  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (line === "") {
      lines.push([]);
      continue;
    }
    if (isOverLength(line.length, maxLineLength)) {
      lines.push([{ content: line, color: "", fontStyle: 0 }]);
      continue;
    }

    const result = grammar.tokenizeLine2(line, state, lineTimeBudgetMs);
    if (result.stoppedEarly) {
      budgetExceededTotal += 1;
      if (budgetExceededLines.length < HIGHLIGHT_BUDGET_LINES_LISTED) {
        budgetExceededLines.push(index + 1);
      }
    }

    const built: TokenizedToken[] = [];
    const count = result.tokens.length / 2;
    for (let i = 0; i < count; i += 1) {
      const startIndex = result.tokens[2 * i] ?? 0;
      const nextStartIndex = i + 1 < count ? (result.tokens[2 * i + 2] ?? 0) : line.length;
      // A zero-width run. Shiki skips these and so do we.
      if (startIndex === nextStartIndex) continue;
      const metadata = result.tokens[2 * i + 1] ?? 0;
      built.push({
        // A PARSING slice: it extracts the run the grammar delimited, which is
        // the opposite of hiding content - every byte of the line lands in
        // exactly one token, and `projectLines` proves that per line.
        content: line.slice(startIndex, nextStartIndex),
        color: applyColorReplacements(colorMap[foregroundOf(metadata)] ?? "", replacements),
        fontStyle: fontStyleOf(metadata),
      });
    }
    lines.push(built);
    // THE REWIND. A line the clock abandoned hands the NEXT line the state it
    // started from, never the stack the scanner was standing in when the budget
    // ran out. VS Code's rule, and the module header measures both sides of it.
    // The partial tokens above are kept either way.
    if (!result.stoppedEarly) state = result.ruleStack;
  }

  return { lines, budgetExceededLines, budgetExceededTotal };
}

/** The colour-map index in a binary token's metadata. */
function foregroundOf(metadata: number): number {
  return (metadata & FOREGROUND_MASK) >>> FOREGROUND_OFFSET;
}

/** The TextMate font-style bits in a binary token's metadata. */
function fontStyleOf(metadata: number): number {
  return (metadata & FONT_STYLE_MASK) >>> FONT_STYLE_OFFSET;
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
  // NO budget accounting on the uncoloured split, for the reason the long-line
  // bound is reported and this one is not: no clock was spent, because no line
  // was scanned. Reporting zero here is the honest statement that this text was
  // never given to a grammar.
  return { lines, longLines, budgetExceededLines: [], budgetExceededTotal: 0 };
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
 * Project shiki's tokens onto the wire shape, under both bounds.
 *
 * A line that shiki skipped for length comes back as EXACTLY ONE token whose
 * colour is the empty string. That is the marker, but it is not what is
 * counted: the length test is applied to the line's own text, so the count
 * stays right even if a future shiki spells "skipped" differently.
 *
 * Two spellings of "no colour" are normalised to `null` here - an absent
 * property (plain-language lines) and an empty string (over-length lines) - so
 * the renderer has one case.
 *
 * ## Cardinality is ALL-OR-NOTHING
 *
 * The tokenizer must return exactly as many lines as the source has. A count
 * that disagrees is not a per-line problem to be patched over: it means the
 * projection and the source no longer describe the same file, and there is no
 * way to tell WHICH lines the surviving ones correspond to. Repairing it line
 * by line would have shown the user a file that is partly the tokenizer's and
 * partly theirs, silently mis-aligned - and, in the extra-lines direction, would
 * have PRESERVED content the source does not contain. So a mismatch is a
 * whole-file plain fallback, reported, and no line of it is trusted.
 *
 * Within a matching count the per-line reconstruction check still applies: the
 * source line is the truth, and a line whose tokens do not concatenate back to
 * it is replaced by one plain token carrying the source text. The colour is
 * lost for that line; the bytes never are.
 *
 * ## The token bound is checked WHILE projecting
 *
 * `maxTokens` is refused as soon as it is crossed, so the oversized array is
 * abandoned half-built and never finished, never returned and never cloned
 * across the worker boundary.
 */
/**
 * Exported for its COLOCATED test only, which drives the reconstruction and
 * cardinality rules with token streams a real grammar will not produce on
 * demand. It is a pure function over its arguments; nothing outside this folder
 * imports it.
 */
export function projectLines(
  tokenized: TokenizedLines,
  text: string,
  maxLineLength: number,
  maxTokens: number,
): TokenizeOutcome {
  const lines = tokenized.lines;
  const sourceLines = text.split(/\r?\n/);

  if (lines.length !== sourceLines.length) {
    warn(
      `the tokenizer returned ${String(lines.length)} line(s) for a ${String(sourceLines.length)}-line file; showing it plain`,
      null,
    );
    // The budget report is DROPPED with the projection it describes. Its line
    // numbers index a tokenization this branch just decided not to trust, and
    // pointing at line 812 of a file being shown plain would be a bound
    // reporting itself against the wrong file.
    return boundedPlain(text, maxLineLength, maxTokens);
  }

  const projected: TokenLine[] = [];
  let longLines = 0;
  let unreconstructed = 0;
  let tokens = 0;

  for (const [index, line] of lines.entries()) {
    let rendered = "";
    const built: HighlightToken[] = [];
    for (const token of line) {
      rendered += token.content;
      const style = token.fontStyle ?? 0;
      built.push({
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
    // rather than shown. `source` cannot be undefined here: the cardinality
    // check above proved the two arrays are the same length.
    const source = sourceLines[index] ?? "";
    let kept: TokenLine = built;
    if (source !== rendered) {
      unreconstructed += 1;
      kept = source.length === 0 ? [] : [plainToken(source)];
    }

    tokens += kept.length;
    if (isOverTokenBound(tokens, maxTokens)) {
      return { ok: false, reason: "too_many_tokens" };
    }
    projected.push(kept);
  }

  if (unreconstructed > 0) {
    warn(
      `${String(unreconstructed)} line(s) did not reconstruct and were shown plain`,
      null,
    );
  }
  if (tokenized.budgetExceededTotal > 0) {
    warn(
      `${String(tokenized.budgetExceededTotal)} line(s) ran out of highlighting budget and are partly coloured, first at line ${String(tokenized.budgetExceededLines[0] ?? 0)}`,
      null,
    );
  }

  return {
    ok: true,
    result: {
      lines: projected,
      longLines,
      budgetExceededLines: tokenized.budgetExceededLines,
      budgetExceededTotal: tokenized.budgetExceededTotal,
    },
  };
}

/**
 * The uncoloured split, under the token bound.
 *
 * Plain text is one token per non-empty line, so a file of very short lines can
 * still cross the bound - and it is refused there for the same reason a
 * coloured one is: the array is what costs, and it costs the same whether or
 * not the tokens carry a colour.
 */
function boundedPlain(
  text: string,
  maxLineLength: number,
  maxTokens: number,
): TokenizeOutcome {
  const result = plainTokenize(text, maxLineLength);
  let tokens = 0;
  for (const line of result.lines) tokens += line.length;
  if (isOverTokenBound(tokens, maxTokens)) return { ok: false, reason: "too_many_tokens" };
  return { ok: true, result };
}

/** Zero or less disables the bound, the way `maxLineLength` does. */
function isOverTokenBound(tokens: number, maxTokens: number): boolean {
  return maxTokens > 0 && tokens > maxTokens;
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
