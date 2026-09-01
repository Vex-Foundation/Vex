/**
 * THE CHAT TRANSCRIPT's syntax highlighter: a small synchronous line tokenizer
 * that returns classed text runs for React to render - never an HTML string
 * (the build bans HTML sinks). Colors live on `.vex-code-*` classes in
 * chat-transcript.css, tokens-only. An unknown or absent language returns
 * null and the caller renders its plain fallback - never an error.
 *
 * ## TWO highlighters, one product, and why that is right
 *
 * This module was once the renderer's only one. Since stage B3c it is one of
 * two, and the split is a difference of POLICY rather than duplication:
 *
 *  - HERE, the chat transcript. A snippet arrives mid-stream and has to paint
 *    in the same frame, so the tokenizer is SYNCHRONOUS and in-bundle. It
 *    covers comments, strings, numbers, keywords and JSON keys - the
 *    readability payload - for the handful of languages chat actually shows,
 *    in a few hundred lines of owned, auditable code. Shiki cannot serve this:
 *    a worker round trip per snippet would leave code grey while it streamed,
 *    and its grammars are megabytes for languages chat never renders.
 *
 *  - `features/appShell/studio/viewer/highlight/`, the Studio file viewer. A
 *    WHOLE FILE in an arbitrary language needs real TextMate grammars, and it
 *    can afford a worker round trip because it happens once when a tab opens.
 *    That owner runs shiki 4 in a module worker, with a bounded hot set of
 *    grammars loaded on demand. The shiki dependency was accepted for it in
 *    stage B1.
 *
 * The two share a PALETTE DIRECTION, not code: keywords carry the accent,
 * strings the success tone, comments recede. `.vex-code-*` here and
 * `--vex-alias-code-token-*` there both resolve to the same aliases, which is
 * what makes a snippet in chat and a file in the viewer read as one product.
 *
 * Do not migrate this to shiki without measuring the streaming frame cost
 * first, and do not grow it toward real grammars: the viewer already owns that
 * problem.
 */

/** One highlighted run of a line. */
export interface HighlightSpan {
  readonly text: string;
  /** Token class: plain | keyword | string | number | comment | property. */
  readonly kind: "plain" | "keyword" | "string" | "number" | "comment" | "property";
}

interface LanguageSpec {
  /** Line-comment opener; comment runs to end of line. */
  readonly lineComment: string | null;
  readonly keywords: ReadonlySet<string>;
  /** String delimiters recognised (single line; an unclosed string ends at EOL). */
  readonly stringDelims: readonly string[];
  /** Highlight a string immediately followed by ":" as a property key (JSON). */
  readonly propertyKeys: boolean;
}

const JS_KEYWORDS = new Set([
  "abstract", "as", "async", "await", "break", "case", "catch", "class",
  "const", "continue", "default", "delete", "do", "else", "enum", "export",
  "extends", "false", "finally", "for", "from", "function", "if", "implements",
  "import", "in", "instanceof", "interface", "let", "new", "null", "of",
  "private", "protected", "public", "readonly", "return", "satisfies",
  "static", "super", "switch", "this", "throw", "true", "try", "type",
  "typeof", "undefined", "var", "void", "while", "yield",
]);

const PY_KEYWORDS = new Set([
  "and", "as", "assert", "async", "await", "break", "class", "continue",
  "def", "del", "elif", "else", "except", "False", "finally", "for", "from",
  "global", "if", "import", "in", "is", "lambda", "None", "nonlocal", "not",
  "or", "pass", "raise", "return", "True", "try", "while", "with", "yield",
]);

const SH_KEYWORDS = new Set([
  "case", "do", "done", "elif", "else", "esac", "export", "fi", "for",
  "function", "if", "in", "local", "return", "then", "until", "while",
]);

const SQL_KEYWORDS = new Set([
  "select", "from", "where", "insert", "into", "values", "update", "set",
  "delete", "create", "table", "index", "join", "left", "right", "inner",
  "outer", "on", "group", "by", "order", "limit", "offset", "and", "or",
  "not", "null", "as", "distinct", "having", "union", "primary", "key",
]);

const SPECS = {
  js: { lineComment: "//", keywords: JS_KEYWORDS, stringDelims: ['"', "'", "`"], propertyKeys: false },
  json: { lineComment: null, keywords: new Set(["true", "false", "null"]), stringDelims: ['"'], propertyKeys: true },
  python: { lineComment: "#", keywords: PY_KEYWORDS, stringDelims: ['"', "'"], propertyKeys: false },
  shell: { lineComment: "#", keywords: SH_KEYWORDS, stringDelims: ['"', "'"], propertyKeys: false },
  sql: { lineComment: "--", keywords: SQL_KEYWORDS, stringDelims: ["'"], propertyKeys: false },
} as const satisfies Record<string, LanguageSpec>;

/**
 * A Map, not an object: fence info strings are assistant-authored, so a label
 * like `constructor` must miss instead of resolving an inherited property.
 */
const LANG_ALIASES = new Map<string, keyof typeof SPECS>([
  ["ts", "js"], ["tsx", "js"], ["typescript", "js"],
  ["js", "js"], ["jsx", "js"], ["javascript", "js"],
  ["json", "json"], ["jsonc", "json"],
  ["py", "python"], ["python", "python"],
  ["sh", "shell"], ["bash", "shell"], ["shell", "shell"], ["zsh", "shell"], ["shellscript", "shell"],
  ["sql", "sql"],
]);

const WORD_RE = /^[A-Za-z_$][A-Za-z0-9_$]*/;
const NUMBER_RE = /^(?:0[xXbBoO][0-9a-fA-F_]+|\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?)/;

function tokenizeLine(line: string, spec: LanguageSpec): HighlightSpan[] {
  const spans: HighlightSpan[] = [];
  let plain = "";
  const flush = (): void => {
    if (plain.length > 0) {
      spans.push({ text: plain, kind: "plain" });
      plain = "";
    }
  };
  let i = 0;
  while (i < line.length) {
    const rest = line.substring(i);
    if (spec.lineComment !== null && rest.startsWith(spec.lineComment)) {
      flush();
      spans.push({ text: rest, kind: "comment" });
      break;
    }
    const ch = rest[0] ?? "";
    if (spec.stringDelims.includes(ch)) {
      // Scan to the matching unescaped delimiter (or EOL for an unclosed one).
      let j = 1;
      while (j < rest.length && rest[j] !== ch) {
        if (rest[j] === "\\") j += 1;
        j += 1;
      }
      const end = j < rest.length ? j + 1 : rest.length;
      const text = rest.substring(0, end);
      flush();
      const isKey =
        spec.propertyKeys && /^\s*:/.test(rest.substring(end));
      spans.push({ text, kind: isKey ? "property" : "string" });
      i += end;
      continue;
    }
    const num = NUMBER_RE.exec(rest);
    if (num !== null && !/[A-Za-z0-9_$]$/.test(plain)) {
      flush();
      spans.push({ text: num[0], kind: "number" });
      i += num[0].length;
      continue;
    }
    const word = WORD_RE.exec(rest);
    if (word !== null && !/[A-Za-z0-9_$]$/.test(plain)) {
      const isKeyword =
        spec.keywords === SQL_KEYWORDS
          ? spec.keywords.has(word[0].toLowerCase())
          : spec.keywords.has(word[0]);
      if (isKeyword) {
        flush();
        spans.push({ text: word[0], kind: "keyword" });
      } else {
        plain += word[0];
      }
      i += word[0].length;
      continue;
    }
    plain += ch;
    i += 1;
  }
  flush();
  return spans;
}

/**
 * Tokenize `code` into per-line classed runs when `lang` maps to a known
 * grammar; null means the caller renders its plain fallback. Synchronous and
 * allocation-light — safe to call from a render path behind a memo.
 */
export function highlightLines(
  code: string,
  lang: string | undefined,
): HighlightSpan[][] | null {
  const key = lang === undefined ? undefined : LANG_ALIASES.get(lang.toLowerCase());
  if (key === undefined) return null;
  const spec = SPECS[key];
  return code.split("\n").map((line) => tokenizeLine(line, spec));
}
