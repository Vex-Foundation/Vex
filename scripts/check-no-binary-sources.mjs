#!/usr/bin/env node
/**
 * NO TRACKED SOURCE FILE IS BINARY.
 *
 * The lesson this gate exists for is a measured one from stage B2: a source
 * file can acquire a NUL byte - a bad paste, an editor writing UTF-16, a
 * mangled patch - and nothing downstream complains loudly. TypeScript reads it,
 * bundlers read it, and git quietly classifies it as binary, at which point
 * every diff-scoped tool in this repository goes blind on it: `git diff` prints
 * "Binary files differ", the em-dash gate cannot scan its added lines, and the
 * unsafe-escape scanner cannot see it either. A file that no gate can read is a
 * file where anything can hide.
 *
 * ## The mechanism, and why this one
 *
 * Both candidate mechanisms were probed against this repository's real tree on
 * 2026-08-31 and they agree EXACTLY - the same 29 files, no difference either
 * way:
 *
 *   git diff --numstat <empty-tree> HEAD   ->  "-\t-\t<path>" for binary
 *   git grep -I --name-only -e ''          ->  omits binary files
 *
 * `git grep` is the one used, for two reasons. It reads the WORKING TREE, so an
 * unstaged edit that turned a file binary is caught before it is ever
 * committed, which is the moment that matters. And it needs no empty-tree hash
 * or revision argument, so it works identically in a fresh clone, a worktree
 * and a shallow CI checkout.
 *
 * Its one edge is that a ZERO-BYTE file matches no line and would look binary;
 * the size check below distinguishes those.
 *
 * ## Scope and exemptions
 *
 * Scanned: tracked AND untracked-but-not-ignored files under `src/` and
 * `vex-app/src/` whose extension is a SOURCE extension. The untracked half is
 * not redundant, for the same reason `scripts/check-no-em-dash.mjs` states for
 * its own second input: a file that was never staged is exactly how a violation
 * reaches a tree, and `git grep` cannot see one. Untracked files are read
 * directly and tested with git's OWN heuristic - a NUL in the first 8000 bytes.
 *
 * Binary assets under those roots (fonts, images, protobuf descriptors) are
 * legitimate and are simply not source extensions, so they need no allowlist.
 *
 * The allowlist below is CLOSED and holds only files whose text legitimately
 * contains a NUL character - real code about NUL handling, where the byte is
 * the subject. Adding to it requires the same justification: the file is text,
 * the NUL is deliberate, and it is named here so its blindness to the other
 * gates is a known cost rather than an accident.
 */

import { execFileSync } from "node:child_process";
import { openSync, closeSync, readSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..");

const SCAN_ROOTS = ["src", "vex-app/src"];

/** Extensions this repository authors as text. */
const SOURCE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".css",
  ".json",
  ".md",
  ".html",
  ".go",
  ".sql",
  ".yml",
  ".yaml",
  ".sh",
  ".txt",
]);

/**
 * Files that are TEXT but carry a deliberate NUL, so git calls them binary.
 *
 * Each is code whose subject is the NUL character itself. They predate this
 * gate; they are recorded rather than rewritten, because changing a literal in
 * sanitization or filename-scrubbing code to make a scanner happy would be
 * changing behaviour to satisfy a tool.
 */
const ALLOWLIST = new Map([
  [
    "src/tools/dexscreener/sanitize.ts",
    "Invisible-character sanitization: a doc example embeds a literal NUL inside a sample string.",
  ],
  [
    "src/vex-agent/engine/prompts/capability-availability.ts",
    "Uses a literal NUL as a composite map-key separator.",
  ],
]);

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

function runGit(args) {
  return execFileSync("git", args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

function listLines(output) {
  return output.split("\n").filter((line) => line.length > 0);
}

/**
 * Git's own binary heuristic: a NUL byte within the first 8000 bytes.
 *
 * Used only for UNTRACKED files, which `git grep` cannot reach. The constant is
 * git's (`buffer_is_binary`, FIRST_FEW_BYTES = 8000), not one invented here, so
 * a file this reports and a file git reports are the same set.
 */
const GIT_FIRST_FEW_BYTES = 8000;

function looksBinary(absolutePath) {
  const handle = openSync(absolutePath, "r");
  try {
    const buffer = Buffer.alloc(GIT_FIRST_FEW_BYTES);
    const read = readSync(handle, buffer, 0, GIT_FIRST_FEW_BYTES, 0);
    return buffer.subarray(0, read).includes(0);
  } finally {
    closeSync(handle);
  }
}

function main() {
  const tracked = listLines(runGit(["ls-files", "--", ...SCAN_ROOTS]));
  const sources = tracked.filter((file) =>
    SOURCE_EXTENSIONS.has(path.extname(file).toLowerCase()),
  );
  if (sources.length === 0) {
    fail(
      `no tracked source files found under ${SCAN_ROOTS.join(", ")} - the scan roots are wrong`,
    );
  }

  // `-I` omits binary files; matching the empty pattern lists every other one.
  const textual = new Set(
    listLines(runGit(["grep", "-I", "--name-only", "-e", "", "--", ...SCAN_ROOTS])),
  );

  const violations = [];
  for (const file of sources) {
    if (textual.has(file)) continue;
    // A zero-byte file has no line to match and is not binary.
    if (statSync(path.join(repositoryRoot, file)).size === 0) continue;
    if (ALLOWLIST.has(file)) continue;
    violations.push(file);
  }

  // UNTRACKED, not ignored: `git grep` cannot see these, and a never-staged
  // file is exactly how a violation reaches the tree.
  const untracked = listLines(
    runGit(["ls-files", "--others", "--exclude-standard", "--", ...SCAN_ROOTS]),
  ).filter((file) => SOURCE_EXTENSIONS.has(path.extname(file).toLowerCase()));
  for (const file of untracked) {
    if (ALLOWLIST.has(file)) continue;
    if (looksBinary(path.join(repositoryRoot, file))) violations.push(file);
  }

  if (violations.length > 0) {
    console.error(
      `✗ ${String(violations.length)} source file(s) are BINARY.`,
    );
    console.error(
      "  A source file with a NUL byte is invisible to every diff-scoped gate in this repository.",
    );
    console.error("  Remove the NUL byte, or re-save the file as UTF-8 text.");
    for (const file of violations) console.error(`    ${file}`);
    process.exit(1);
  }

  // Keep the allowlist honest: an entry whose file is gone, or is now clean, is
  // stale and must shrink.
  const stale = [...ALLOWLIST.keys()].filter(
    (file) => !sources.includes(file) || textual.has(file),
  );
  if (stale.length > 0) {
    console.error("✗ stale binary-source allowlist entries (remove them):");
    for (const file of stale) console.error(`    ${file}`);
    process.exit(1);
  }

  console.log(
    `✓ No binary sources - ${String(sources.length)} tracked and ${String(untracked.length)} untracked source file(s) scanned, ${String(ALLOWLIST.size)} allowlisted.`,
  );
}

main();
