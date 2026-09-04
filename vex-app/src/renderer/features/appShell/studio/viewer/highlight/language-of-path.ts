/**
 * THE ONE path-to-language table.
 *
 * Every decision about "what language is this file" is here, and it is a
 * TABLE rather than a chain of `endsWith` calls so the whole surface can be
 * read and tested at once. Nothing else in the viewer may guess a language.
 *
 * ## The hot set is BOUNDED and the bound is named
 *
 * Shiki ships 300+ grammars. Loading them all would put megabytes of TextMate
 * JSON into the renderer for a product whose users open TypeScript, config and
 * the occasional contract. So this table maps only {@link HOT_LANGUAGES}, and
 * EVERYTHING ELSE maps to `"text"` - which is not a failure and not a silent
 * cut: a file with no grammar renders in full, with line numbers and a chip
 * that says it is not highlighted. The user loses colour, never content.
 *
 * Growing the set is a one-line change here plus one in the loader table in
 * `shiki-tokenizer.ts`, and the two are kept in step by
 * `shiki-tokenizer.test.ts`, which asserts every hot id has a loader.
 *
 * ## Why these seventeen
 *
 * The languages a Vex project actually contains: the app's own stack
 * (typescript/tsx/javascript/jsx), everything that configures it
 * (json/jsonc/yaml/toml/markdown), the languages agents most often write
 * (python/rust/go/sql/shellscript), the web pair (css/html), and solidity,
 * because Vex is a crypto product and a user reading a contract is reading the
 * thing their money depends on.
 *
 * All seventeen were verified to LOAD and TOKENIZE against the installed
 * shiki 4.4.3 with the JavaScript regex engine at `forgiving: false`; that
 * probe is what fixed the list, not convention.
 *
 * ## Case, and what is deliberately not here
 *
 * Extensions are matched case-INSENSITIVELY (`.TS` is TypeScript; Windows and
 * macOS filesystems hand us either). Exact file NAMES are matched
 * case-sensitively, because `Dockerfile` and `dockerfile` are different files
 * on Linux and the convention is exact.
 *
 * There is no content sniffing and no shebang parsing. Both are guesses about
 * bytes, and a wrong guess paints a Python file as shell - worse than plain
 * text, because it looks authoritative.
 */

/**
 * The shiki language ids this feature will ever ask for.
 *
 * `shellscript` is the canonical id; shiki registers `bash`, `sh`, `shell` and
 * `zsh` as its ALIASES when the grammar loads, which is why `.sh` and `.zsh`
 * map to `shellscript` here rather than to an alias: one id per grammar keeps
 * the loader table single-valued.
 */
export const HOT_LANGUAGES = [
  "typescript",
  "tsx",
  "javascript",
  "jsx",
  "json",
  "jsonc",
  "markdown",
  "python",
  "rust",
  "go",
  "yaml",
  "toml",
  "css",
  "html",
  "shellscript",
  "sql",
  "solidity",
] as const;

export type HotLanguageId = (typeof HOT_LANGUAGES)[number];

/**
 * The language of a file with no grammar. Shiki treats this id specially and
 * emits one uncoloured token per line, so it is a real answer, not a fallback
 * that skips work.
 */
export const PLAIN_LANGUAGE = "text";

export type ViewerLanguageId = HotLanguageId | typeof PLAIN_LANGUAGE;

const HOT_LANGUAGE_SET: ReadonlySet<string> = new Set<string>(HOT_LANGUAGES);

/** Is this id one the tokenizer has a grammar loader for? */
export function isHotLanguage(id: string): id is HotLanguageId {
  return HOT_LANGUAGE_SET.has(id);
}

/**
 * Extension (WITHOUT the dot, lowercased) to language id.
 *
 * A file's LAST extension decides: `service.test.ts` is TypeScript and
 * `schema.d.ts` is TypeScript. `.tar.gz` style compound extensions are not a
 * thing this table needs, because neither half is a language it knows.
 */
const BY_EXTENSION: Readonly<Record<string, ViewerLanguageId>> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "tsx",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "jsx",
  json: "json",
  jsonc: "jsonc",
  // Both are JSON with comments and trailing commas in practice, and reading
  // one as strict JSON paints every comment as an error colour.
  json5: "jsonc",
  md: "markdown",
  markdown: "markdown",
  mdx: "markdown",
  py: "python",
  pyi: "python",
  rs: "rust",
  go: "go",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  css: "css",
  html: "html",
  htm: "html",
  sh: "shellscript",
  bash: "shellscript",
  zsh: "shellscript",
  sql: "sql",
  sol: "solidity",
};

/**
 * Exact file names, matched before any extension logic.
 *
 * `Dockerfile` and `Makefile` are here as EXPLICIT `text` entries rather than
 * being left to fall through, so the table states the decision instead of
 * leaving it to be re-derived: neither `docker` nor `makefile` is in the hot
 * set, and a Makefile shown with shell highlighting would colour its tab-
 * significant recipe lines as if they were a shell script.
 *
 * `.env` is `text` for a stronger reason: it holds secrets, and a grammar that
 * split `KEY=value` into a keyword and a string run would make the value the
 * one visually emphasised thing on the row.
 */
const BY_EXACT_NAME: Readonly<Record<string, ViewerLanguageId>> = {
  Dockerfile: PLAIN_LANGUAGE,
  Makefile: PLAIN_LANGUAGE,
  makefile: PLAIN_LANGUAGE,
  GNUmakefile: PLAIN_LANGUAGE,
  ".env": PLAIN_LANGUAGE,
  ".gitignore": PLAIN_LANGUAGE,
  ".npmrc": PLAIN_LANGUAGE,
  ".editorconfig": PLAIN_LANGUAGE,
  ".prettierrc": "json",
  ".babelrc": "json",
  ".eslintrc": "json",
};

/**
 * The last path segment of a project-relative POSIX path.
 *
 * The only path arithmetic in this module. Paths on the files surface are
 * POSIX and project-relative (see `@shared/schemas/files.ts`), so a backslash
 * is a legal character in a name and must NOT be treated as a separator.
 */
function baseNameOf(path: string): string {
  const at = path.lastIndexOf("/");
  return at === -1 ? path : path.slice(at + 1);
}

/**
 * The language a file at this project-relative path should be highlighted as.
 *
 * Total: every input has an answer, and the answer for anything unrecognised is
 * {@link PLAIN_LANGUAGE}. Never throws.
 */
export function languageOfPath(path: string): ViewerLanguageId {
  const name = baseNameOf(path);
  if (name.length === 0) return PLAIN_LANGUAGE;

  const exact = BY_EXACT_NAME[name];
  if (exact !== undefined) return exact;

  // A leading dot is part of the NAME (`.env.local`), not an extension marker,
  // so the search for the extension separator starts after it. Without this,
  // `.gitignore` would be read as the extension `gitignore`.
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return PLAIN_LANGUAGE;

  const extension = name.slice(dot + 1).toLowerCase();
  return BY_EXTENSION[extension] ?? PLAIN_LANGUAGE;
}

/**
 * The label shown in the viewer's header strip.
 *
 * Separate from the id because `shellscript` and `tsx` are ids a tokenizer
 * understands and not words a person would choose. Plain text says "Plain
 * text" rather than nothing, so the header never has an empty slot.
 */
const LANGUAGE_LABELS: Readonly<Record<ViewerLanguageId, string>> = {
  typescript: "TypeScript",
  tsx: "TSX",
  javascript: "JavaScript",
  jsx: "JSX",
  json: "JSON",
  jsonc: "JSON with comments",
  markdown: "Markdown",
  python: "Python",
  rust: "Rust",
  go: "Go",
  yaml: "YAML",
  toml: "TOML",
  css: "CSS",
  html: "HTML",
  shellscript: "Shell",
  sql: "SQL",
  solidity: "Solidity",
  text: "Plain text",
};

export function languageLabel(language: ViewerLanguageId): string {
  return LANGUAGE_LABELS[language];
}
