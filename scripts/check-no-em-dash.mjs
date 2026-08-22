#!/usr/bin/env node
/**
 * Diff-scoped em-dash gate for authored content.
 *
 * The owner forbids U+2014 in anything we author: docs, release notes, UI copy,
 * tool descriptions, comments, commit messages. This gate enforces that on the
 * content THIS branch introduces, not repo-wide: pre-existing em dashes on
 * untouched lines are historical debt and outside any single card's patch
 * (rule 00 scope), exactly like the sibling gate in
 * `scripts/check-test-unsafe-escapes.mjs`, whose structure this mirrors.
 *
 * TWO INPUTS, because either one alone leaves a hole:
 *
 *   1. the ADDED lines of `git diff <merge-base>` for tracked files;
 *   2. the FULL content of untracked authored files
 *      (`git ls-files --others --exclude-standard`).
 *
 * (2) is not redundant. A merge-base diff cannot see a file that was never
 * staged, and that is precisely how the violation this gate was written for
 * reached the tree: a new, untracked lint module carrying two em-dash lines
 * passed every diff-scoped check.
 *
 * `src/vex-agent/tools/__toolsnaps__` and
 * `src/vex-agent/engine/prompts/__promptsnaps__` are excluded because they
 * are generated output, not authored content: their text is regenerated from
 * the manifests and the prompt modules, so those sources are where a violation
 * is fixed and where this gate must fail.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..");

/** U+2014. Built from its code point so this file does not trip its own gate. */
const EM_DASH = String.fromCharCode(0x2014);

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
 * it. A branch-wide `git diff` exceeds that easily, and the failure looks like
 * a broken script rather than "the diff got big".
 */
const GIT_OUTPUT_MAX_BYTES = 64 * 1024 * 1024;

function runGit(args) {
  return execFileSync("git", args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    maxBuffer: GIT_OUTPUT_MAX_BYTES,
  });
}

/**
 * Authored-content path policy. Everything under the product and docs trees
 * plus every Markdown file anywhere, minus generated output and dependencies.
 */
function isAuthoredContent(file) {
  if (file.includes("node_modules/")) return false;
  if (file.startsWith("src/vex-agent/tools/__toolsnaps__/")) return false;
  if (file.startsWith("src/vex-agent/engine/prompts/__promptsnaps__/")) return false;
  return (
    file.startsWith("src/")
    || file.startsWith("vex-app/src/")
    || file.startsWith("docs/")
    || file.startsWith("scripts/")
    || file.endsWith(".md")
  );
}

/**
 * The gate is only meaningful against the real branch point: a wrong or absent
 * base silently shrinks the added-line set and reports green. Both candidates
 * are computed, never hardcoded, so the range follows the branch.
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

function addedLinesByFile(base) {
  const output = runGit(["diff", "--unified=0", base]);
  const lines = new Map();
  let currentFile = null;
  let nextLine = 0;
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith("+++ b/")) {
      currentFile = line.slice(6);
      continue;
    }
    if (line.startsWith("+++ ")) {
      // `+++ /dev/null`: a deletion has no destination content to scan.
      currentFile = null;
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

function untrackedFiles() {
  return runGit(["ls-files", "--others", "--exclude-standard"]).split(/\r?\n/).filter(Boolean);
}

/** `null` for `addedLines` means "scan every line" (an untracked new file). */
function inspectFile(file, addedLines) {
  const absolute = path.join(repositoryRoot, file);
  // A file deleted or moved since the diff was computed has nothing to scan.
  if (!existsSync(absolute)) return [];
  const findings = [];
  for (const [index, line] of readFileSync(absolute, "utf8").split(/\r?\n/).entries()) {
    const lineNumber = index + 1;
    if (addedLines !== null && !addedLines.has(lineNumber)) continue;
    if (line.includes(EM_DASH)) findings.push(`${file}:${lineNumber} ${line.trim()}`);
  }
  return findings;
}

function main() {
  const base = argumentValue("--base") ?? deriveMergeBase();
  console.log(`• comparing against base ${base}`);

  const findings = [];
  for (const [file, addedLines] of addedLinesByFile(base)) {
    if (isAuthoredContent(file)) findings.push(...inspectFile(file, addedLines));
  }
  for (const file of untrackedFiles()) {
    if (isAuthoredContent(file)) findings.push(...inspectFile(file, null));
  }

  if (findings.length > 0) {
    fail(
      `em dash (U+2014) in authored content added by this branch:\n${findings.join("\n")}\n`
        + "  Use a plain hyphen \"-\" between clauses, or a comma or a period where the sentence reads better.",
    );
  }
  console.log("✓ no em dashes in authored content added by this branch");
}

main();
