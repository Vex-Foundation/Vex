/**
 * Migration filename identity guard.
 *
 * Prefixes 079-084 already shipped with two files each and cannot be
 * renumbered safely. The shared runner therefore keeps legacy numeric history
 * in `schema_version` and exact applied filenames in a companion ledger. This
 * test freezes the known collision set so no new duplicate prefix can sneak
 * in, and verifies the Electron mirror contains the exact same filenames.
 */

import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";

const SRC_DIR = resolve(process.cwd(), "src/vex-agent/db/migrations");
const APP_DIR = resolve(process.cwd(), "vex-app");
const MIRROR_DIR = resolve(APP_DIR, "resources/migrations");

// Mirrors the exact filter used by `listPendingMigrations` (migrate-runner)
// and `isMigrationFile` (copy-migrations.mjs) — both must agree with this.
function isMigrationFile(name: string): boolean {
  return name.endsWith(".sql") && /^\d{3}_/.test(name);
}

function migrationPrefixes(dir: string): string[] {
  return readdirSync(dir)
    .filter(isMigrationFile)
    .map((name) => name.slice(0, 3));
}

function migrationFiles(dir: string): string[] {
  return readdirSync(dir).filter(isMigrationFile).sort();
}

function findDuplicates(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const v of values) {
    if (seen.has(v)) dupes.add(v);
    seen.add(v);
  }
  return [...dupes].sort();
}

const SHIPPED_DUPLICATE_PREFIXES = ["079", "080", "081", "082", "083", "084"];

describe("migration filename identity", () => {
  it("allows only the already-shipped duplicate numeric prefixes", () => {
    const prefixes = migrationPrefixes(SRC_DIR);
    expect(prefixes.length).toBeGreaterThan(0);
    expect(findDuplicates(prefixes)).toEqual(SHIPPED_DUPLICATE_PREFIXES);
  });

  it("keeps the same shipped duplicate prefixes in the vex-app mirror", () => {
    execFileSync("node", ["scripts/copy-migrations.mjs"], {
      cwd: APP_DIR,
      stdio: "pipe",
    });
    const prefixes = migrationPrefixes(MIRROR_DIR);
    expect(prefixes.length).toBeGreaterThan(0);
    expect(findDuplicates(prefixes)).toEqual(SHIPPED_DUPLICATE_PREFIXES);
  });

  it("mirror filenames exactly match source filenames (copy-script filter parity)", () => {
    execFileSync("node", ["scripts/copy-migrations.mjs"], {
      cwd: APP_DIR,
      stdio: "pipe",
    });
    expect(migrationFiles(MIRROR_DIR)).toEqual(migrationFiles(SRC_DIR));
  });
});
