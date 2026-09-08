#!/usr/bin/env node
/**
 * Regenerates `main-before-lighter.json`: the exact migration set main carried
 * at the pinned commit, with the SHA-256 of every file's contents.
 *
 * WHY THIS FIXTURE EXISTS. The upgrade matrix has to build "a populated
 * database at current main" without importing main's tree at test time. Reading
 * the working tree instead would make the test tautological: it would prove the
 * branch upgrades from itself. Pinning filenames AND content hashes makes the
 * baseline a reviewed artifact, so a change to a main-era migration file is a
 * deliberate diff to this fixture rather than a silent shift of the baseline.
 *
 * Migration contents on main are immutable after release: verified 2026-09-07,
 * every file shared by v0.1.0, v0.2.7 and the pinned commit hashes identically.
 *
 * Regenerate (from the repository root) only when main's migration set has
 * genuinely moved, and update PINNED_COMMIT in the same change:
 *
 *   node src/__tests__/integration/migrations/fixtures/generate-main-migrations-fixture.mjs
 *
 * Validation gate: `upgrade-matrix.int.test.ts` fails when the fixture and the
 * working tree disagree, and (when the pinned commit is present in the clone)
 * when the fixture and `git ls-tree <PINNED_COMMIT>` disagree.
 */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";

const PINNED_COMMIT = "c01f1a4eb2a85bdc0415d2e0f81ac3676e4f8f81";
const MIGRATIONS_PATH = "src/vex-agent/db/migrations";
const OUT = path.join(import.meta.dirname, "main-before-lighter.json");

function git(args) {
  return execFileSync("git", args, { encoding: "buffer", maxBuffer: 32 * 1024 * 1024 });
}

const listing = git(["ls-tree", "--name-only", PINNED_COMMIT, `${MIGRATIONS_PATH}/`])
  .toString("utf8")
  .split("\n")
  .filter((line) => line.endsWith(".sql"))
  .map((line) => path.posix.basename(line))
  .sort();

if (listing.length === 0) {
  console.error(`[main-migrations-fixture] no migrations at ${PINNED_COMMIT}`);
  process.exit(1);
}

const files = listing.map((file) => ({
  file,
  sha256: createHash("sha256")
    .update(git(["show", `${PINNED_COMMIT}:${MIGRATIONS_PATH}/${file}`]))
    .digest("hex"),
}));

writeFileSync(
  OUT,
  `${JSON.stringify({ pinnedCommit: PINNED_COMMIT, migrationsPath: MIGRATIONS_PATH, files }, null, 2)}\n`
);

console.log(
  `[main-migrations-fixture] ${files.length} migration(s) pinned at ${PINNED_COMMIT.slice(0, 9)} -> ${path.relative(process.cwd(), OUT)}`
);
