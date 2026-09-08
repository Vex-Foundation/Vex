/**
 * Migration filename identity guard.
 *
 * A migration's identity is its numeric prefix and nothing else: the runner
 * plans by `version > appliedThrough` and records that integer in
 * `schema_version` (src/lib/db/migrate-runner.ts). Two files sharing a prefix
 * therefore share one ledger row, and whichever ran second is invisible to
 * every later run. The Lighter branch shipped 25 such collisions and had to
 * carry a second, filename-keyed ledger to survive them; that ledger is gone
 * and the numbers are unique again, so this test is what keeps them unique.
 *
 * There is no allowlist. A duplicate prefix is a defect, not a fact to record.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const SRC_DIR = resolve(process.cwd(), "src/vex-agent/db/migrations");
const RUNNER = resolve(process.cwd(), "src/lib/db/migrate-runner.ts");
const COPY_SCRIPT = resolve(process.cwd(), "vex-app/scripts/copy-migrations.mjs");

/**
 * Mirrors the exact filter used by `listMigrationFiles` (migrate-runner) and
 * `isMigrationFile` (copy-migrations.mjs). The last test in this file proves
 * all three still agree.
 */
function isMigrationFile(name: string): boolean {
  return name.endsWith(".sql") && /^\d{3}_/.test(name);
}

function migrationFiles(dir: string): string[] {
  return readdirSync(dir).filter(isMigrationFile).sort();
}

function duplicatePrefixes(files: readonly string[]): Record<string, string[]> {
  const byPrefix = new Map<string, string[]>();
  for (const file of files) {
    const prefix = file.slice(0, 3);
    byPrefix.set(prefix, [...(byPrefix.get(prefix) ?? []), file]);
  }
  return Object.fromEntries(
    [...byPrefix.entries()]
      .filter(([, names]) => names.length > 1)
      .sort(([a], [b]) => a.localeCompare(b))
  );
}

describe("migration filename identity", () => {
  it("gives every migration its own numeric prefix", () => {
    const files = migrationFiles(SRC_DIR);
    expect(files.length).toBeGreaterThan(0);
    expect(duplicatePrefixes(files)).toEqual({});
  });

  it("names one file per version the runner will record in schema_version", () => {
    const files = migrationFiles(SRC_DIR);
    const versions = files.map((file) => Number.parseInt(file.slice(0, 3), 10));
    expect(versions.every(Number.isInteger)).toBe(true);
    expect(new Set(versions).size).toBe(files.length);
    // Ascending filename order is ascending version order: the runner sorts by
    // filename and applies in that order, so the two must not diverge.
    expect([...versions].sort((a, b) => a - b)).toEqual(versions);
  });

  /**
   * The packaged mirror is a generated, git-ignored build artifact rebuilt by
   * `pnpm --filter vex-app build:assets` before every build and dev run, so a
   * test must not regenerate it as a side effect. What can go wrong silently is
   * the two discovery filters drifting apart: a file the runner applies but the
   * copy script skips would be missing from the packaged app. Compare the
   * filters themselves.
   */
  it("discovers migrations by the same filter in the runner and the packaged-mirror script", () => {
    const runner = readFileSync(RUNNER, "utf8");
    const copyScript = readFileSync(COPY_SCRIPT, "utf8");
    const filter = /\.endsWith\("\.sql"\)\s*&&\s*\/\^\\d\{3\}_\/\.test\(/;
    expect(runner).toMatch(filter);
    expect(copyScript).toMatch(filter);
  });
});
