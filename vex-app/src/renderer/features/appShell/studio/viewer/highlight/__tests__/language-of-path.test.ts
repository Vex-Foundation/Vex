/**
 * The path-to-language table.
 *
 * A TABLE test, because the subject is a table: the defect this catches is not
 * a wrong algorithm but a wrong or missing ROW, and the only way to see a
 * missing row is to enumerate the ones that must exist. The three rules that
 * are easy to get subtly wrong and are asserted explicitly:
 *
 *  - the LAST extension decides (`schema.d.ts` is TypeScript, not `d`);
 *  - a leading dot is part of the NAME, so `.gitignore` has no extension;
 *  - extensions are case-insensitive and exact names are not.
 */

import { describe, expect, it } from "vitest";
import {
  HOT_LANGUAGES,
  isHotLanguage,
  languageLabel,
  languageOfPath,
  PLAIN_LANGUAGE,
  type ViewerLanguageId,
} from "../language-of-path.js";

const ROWS: readonly (readonly [string, ViewerLanguageId])[] = [
  // The hot set, one real path each.
  ["src/app.ts", "typescript"],
  ["src/App.tsx", "tsx"],
  ["scripts/build.js", "javascript"],
  ["src/Legacy.jsx", "jsx"],
  ["package.json", "json"],
  ["tsconfig.jsonc", "jsonc"],
  ["README.md", "markdown"],
  ["tools/probe.py", "python"],
  ["crates/core/src/lib.rs", "rust"],
  ["cmd/main.go", "go"],
  ["compose.yaml", "yaml"],
  ["Cargo.toml", "toml"],
  ["styles/app.css", "css"],
  ["public/index.html", "html"],
  ["scripts/release.sh", "shellscript"],
  ["db/schema.sql", "sql"],
  ["contracts/Vault.sol", "solidity"],

  // Aliases the brief names.
  ["vite.config.mjs", "javascript"],
  ["postcss.config.cjs", "javascript"],
  ["src/env.mts", "typescript"],
  ["src/env.cts", "typescript"],
  ["compose.yml", "yaml"],
  ["scripts/dev.zsh", "shellscript"],
  ["scripts/dev.bash", "shellscript"],
  ["page.htm", "html"],
  ["types.pyi", "python"],
  ["notes.markdown", "markdown"],
  ["docs/guide.mdx", "markdown"],
  ["config.json5", "jsonc"],

  // Exact names.
  ["Dockerfile", PLAIN_LANGUAGE],
  ["docker/Dockerfile", PLAIN_LANGUAGE],
  ["Makefile", PLAIN_LANGUAGE],
  ["makefile", PLAIN_LANGUAGE],
  ["GNUmakefile", PLAIN_LANGUAGE],
  [".env", PLAIN_LANGUAGE],
  [".gitignore", PLAIN_LANGUAGE],
  [".npmrc", PLAIN_LANGUAGE],
  [".editorconfig", PLAIN_LANGUAGE],
  [".prettierrc", "json"],
  [".babelrc", "json"],
  [".eslintrc", "json"],

  // Unknowns, and the shapes that trip a naive splitter.
  ["assets/logo.png", PLAIN_LANGUAGE],
  ["LICENSE", PLAIN_LANGUAGE],
  ["archive.tar.gz", PLAIN_LANGUAGE],
  ["src/", PLAIN_LANGUAGE],
  ["", PLAIN_LANGUAGE],
  [".", PLAIN_LANGUAGE],
  ["weird.name.with.dots.ts", "typescript"],
  ["schema.d.ts", "typescript"],
  // Backslash is a legal NAME character on the POSIX files surface, never a
  // separator. `a\b.ts` is one file called `a\b.ts`.
  ["dir/a\\b.ts", "typescript"],
];

describe("languageOfPath", () => {
  it.each(ROWS)("%s -> %s", (path, expected) => {
    expect(languageOfPath(path)).toBe(expected);
  });

  it.each(["src/APP.TS", "src/App.TSX", "COMPOSE.YML", "Cargo.TOML"])(
    "matches the extension case-insensitively: %s",
    (path) => {
      expect(languageOfPath(path)).not.toBe(PLAIN_LANGUAGE);
    },
  );

  it("matches exact NAMES case-sensitively", () => {
    // `DOCKERFILE` is a different file from `Dockerfile` on a case-sensitive
    // filesystem, and it has no extension, so it falls through to plain text
    // rather than matching the `Dockerfile` row.
    expect(languageOfPath("DOCKERFILE")).toBe(PLAIN_LANGUAGE);
  });

  it("never returns an id outside the hot set plus plain text", () => {
    for (const [path] of ROWS) {
      const language = languageOfPath(path);
      expect(language === PLAIN_LANGUAGE || isHotLanguage(language)).toBe(true);
    }
  });
});

describe("languageLabel", () => {
  const EVERY_LANGUAGE: readonly ViewerLanguageId[] = [...HOT_LANGUAGES, PLAIN_LANGUAGE];

  it.each(EVERY_LANGUAGE)("%s has a human label", (id) => {
    expect(languageLabel(id).length).toBeGreaterThan(0);
  });

  it("gives every id its OWN label, so the header can never be ambiguous", () => {
    const labels = EVERY_LANGUAGE.map((id) => languageLabel(id));
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("spells the ids a person would not recognise as words", () => {
    // The two the table exists for: `shellscript` and `tsx` are tokenizer ids,
    // not names anyone would choose for a header strip.
    expect(languageLabel("shellscript")).toBe("Shell");
    expect(languageLabel("text")).toBe("Plain text");
  });
});
