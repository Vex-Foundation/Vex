/**
 * Integration: repeated migration runs are a no-op, and the ledger records
 * exactly one row per migration file.
 *
 * globalSetup already ran the migrations once before this suite loads, so the
 * test effectively asserts a second run changes nothing. A migration's identity
 * is its numeric prefix: one file, one version, one `schema_version` row.
 */

import { describe, it, expect } from "vitest";

import { runMigrations } from "@vex-agent/db/migrate.js";
import { query } from "@vex-agent/db/client.js";
import { readdirSync } from "node:fs";
import { getVexAgentMigrationsDir } from "@utils/package-assets.js";

function migrationFiles(): string[] {
  return readdirSync(getVexAgentMigrationsDir()).filter(
    (f) => f.endsWith(".sql") && /^\d{3}_/.test(f),
  ).sort();
}

describe("runMigrations idempotency (integration)", () => {
  it("second run preserves every applied version and adds nothing", async () => {
    const files = migrationFiles();
    const versions = files.map((file) => Number.parseInt(file.slice(0, 3), 10));
    // No duplicate prefixes: every file has its own ledger row.
    expect(new Set(versions).size).toBe(files.length);

    const readVersions = () => query<{ version: number; applied_at: Date }>(
      "SELECT version, applied_at FROM schema_version ORDER BY version",
    );

    const before = await readVersions();
    expect(before.map(({ version }) => version)).toEqual(versions);

    await expect(runMigrations()).resolves.toBeUndefined();

    expect(await readVersions()).toEqual(before);
  });

  it("keeps exactly one schema marker row, which is what admits the next run", async () => {
    // The runner refuses a database whose Lighter tables exist without exactly
    // one `main-2026-09` marker row (MigrationBranchEraDatabaseError). The
    // second run above proves the marker survived this suite's resets; assert
    // its contents so a truncation that silently empties it is caught here and
    // not as an unexplained refusal in a later suite.
    expect(await query<{ lineage: string }>("SELECT lineage FROM lighter_schema_marker"))
      .toEqual([{ lineage: "main-2026-09" }]);
  });
});
