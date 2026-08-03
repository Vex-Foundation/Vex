#!/usr/bin/env node
/**
 * Diff-scoped anti-evasion gate for test fixes. TypeScript's AST identifies
 * actual assertions/non-null expressions; added-line filtering avoids failing
 * on historical debt outside a remediation card's patch.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..");

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

function argumentValue(flag) {
  const index = process.argv.indexOf(flag);
  return index === -1 ? null : process.argv[index + 1] ?? null;
}

/**
 * `execFileSync` defaults to a 1 MiB stdout buffer and THROWS `ENOBUFS` past
 * it. A branch-wide `git diff` of the test tree exceeds that easily, and the
 * failure looks like a broken script rather than "the diff got big" — which is
 * exactly when this check matters most. 64 MiB is far beyond any diff this
 * repository produces while still being a bound.
 */
const GIT_OUTPUT_MAX_BYTES = 64 * 1024 * 1024;

function runGit(args) {
  return execFileSync("git", args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    maxBuffer: GIT_OUTPUT_MAX_BYTES,
  });
}

function changedTestFiles(base) {
  const status = runGit(["diff", "--name-status", "-z", base, "--", "src/__tests__"]);
  const tokens = status.split("\0").filter(Boolean);
  const files = [];
  for (let index = 0; index < tokens.length; index += 2) {
    const kind = tokens[index];
    const file = tokens[index + 1];
    if (!kind || !file) continue;
    if (kind.startsWith("D")) fail(`test deletion is prohibited in this remediation pass: ${file}`);
    if (/\.(?:test|int\.test)\.[cm]?[jt]sx?$/.test(file)) files.push(file);
  }
  return files;
}

function changedPaths(base) {
  return runGit(["diff", "--name-only", base]).split(/\r?\n/).filter(Boolean);
}

function addedLinesByFile(base) {
  const output = runGit(["diff", "--unified=0", base, "--", "src/__tests__"]);
  const lines = new Map();
  let currentFile = null;
  let nextLine = 0;
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith("+++ b/")) {
      currentFile = line.slice(6);
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      nextLine = Number(hunk[1]);
      continue;
    }
    if (!currentFile || nextLine === 0) continue;
    if (line.startsWith("+")) {
      if (!lines.has(currentFile)) lines.set(currentFile, new Set());
      lines.get(currentFile).add(nextLine);
      nextLine += 1;
    } else if (!line.startsWith("-")) {
      nextLine += 1;
    }
  }
  return lines;
}

function lineOf(sourceFile, position) {
  return sourceFile.getLineAndCharacterOfPosition(position).line + 1;
}

function isForbiddenAssertion(node) {
  if (!ts.isAsExpression(node) && !ts.isTypeAssertionExpression(node)) return null;
  if (node.type.kind === ts.SyntaxKind.AnyKeyword) return "as any";
  /**
   * `as never` is `as any`'s twin for test evasion: it type-checks against every
   * parameter position, so a fake object cast to it silences exactly the errors
   * a real typed double would surface.
   */
  if (node.type.kind === ts.SyntaxKind.NeverKeyword) return "as never";
  if ((ts.isAsExpression(node.expression) || ts.isTypeAssertionExpression(node.expression))
    && node.expression.type.kind === ts.SyntaxKind.UnknownKeyword) return "as unknown as";
  return null;
}

function isFocusedTestModifier(node) {
  if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return null;
  const modifier = node.expression.name.text;
  if (modifier !== "skip" && modifier !== "only") return null;
  const target = node.expression.expression.getText();
  return ["it", "test", "describe", "context", "suite"].includes(target) ? `.${modifier}` : null;
}

function inspectFile(file, addedLines) {
  const absolute = path.join(repositoryRoot, file);
  if (!existsSync(absolute)) fail(`changed test file is missing: ${file}`);
  const source = readFileSync(absolute, "utf8");
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const findings = [];
  const addFinding = (node, reason) => {
    const line = lineOf(sourceFile, node.getStart(sourceFile));
    if (addedLines.has(line)) findings.push(`${file}:${line} ${reason}`);
  };
  const visit = (node) => {
    const assertion = isForbiddenAssertion(node);
    if (assertion) addFinding(node, assertion);
    if (node.kind === ts.SyntaxKind.AnyKeyword) addFinding(node, "any type");
    if (ts.isNonNullExpression(node)) addFinding(node, "non-null assertion");
    const modifier = isFocusedTestModifier(node);
    if (modifier) addFinding(node, `test ${modifier}`);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  for (const [index, line] of source.split(/\r?\n/).entries()) {
    const lineNumber = index + 1;
    if (addedLines.has(lineNumber) && /@ts-(?:ignore|nocheck|expect-error)\b/.test(line)) findings.push(`${file}:${lineNumber} TypeScript suppression comment`);
  }
  return findings;
}

/**
 * The gate is only meaningful against the real branch point: a wrong or absent
 * base silently shrinks the added-line set and reports green. `--base` stays
 * available for ad-hoc runs, but the packaged command must not depend on the
 * caller remembering it, so the base is derived here:
 *
 *   1. `git merge-base HEAD origin/main` — the branch point against the shared
 *      trunk, correct on any feature branch with a fetched remote;
 *   2. `git merge-base HEAD main` — same intent when only a local `main` exists.
 *
 * Both are computed, never hardcoded: pinning a commit would keep passing after
 * the branch moves on. If neither ref resolves, the run fails rather than
 * scanning an arbitrary range.
 */
function deriveMergeBase() {
  for (const trunk of ["origin/main", "main"]) {
    try {
      return runGit(["merge-base", "HEAD", trunk]).trim();
    } catch {
      continue;
    }
  }
  return fail("cannot derive a merge base: neither origin/main nor main resolves; pass --base <revision>");
}

function main() {
  const base = argumentValue("--base") ?? deriveMergeBase();
  console.log(`• comparing against base ${base}`);
  const forbiddenPaths = new Set(["tsconfig.json", "tsconfig.test.json", "scripts/test-type-baseline.json", "scripts/test-type-baseline-allowlist.json"]);
  const changedForbidden = changedPaths(base).filter((file) => forbiddenPaths.has(file));
  if (changedForbidden.length > 0) fail(`this remediation patch may not edit type config or ratchet baseline files: ${changedForbidden.join(", ")}`);

  const addedLines = addedLinesByFile(base);
  const findings = changedTestFiles(base).flatMap((file) => inspectFile(file, addedLines.get(file) ?? new Set()));
  if (findings.length > 0) fail(`unsafe test escape(s) added:\n${findings.join("\n")}`);
  console.log("✓ no unsafe escapes, focused tests, deletions, or config/baseline edits in changed test files");
}

main();
