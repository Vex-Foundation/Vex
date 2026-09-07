/**
 * Integration: repeated migration runs preserve both the numeric version
 * history and the exact filename ledger, including colliding prefixes.
 *
 * globalSetup already ran the migrations once before this suite loads, so the
 * test effectively asserts a second run is a no-op.
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
  it("second run preserves every exact filename and distinct numeric version", async () => {
    const files = migrationFiles();
    const versions = [...new Set(files.map((file) => Number.parseInt(file.slice(0, 3), 10)))].sort((a, b) => a - b);
    const readVersions = () => query<{ version: number; applied_at: Date }>(
      "SELECT version, applied_at FROM schema_version ORDER BY version",
    );
    const readFiles = () => query<{ file: string; version: number; applied_at: Date }>(
      "SELECT file, version, applied_at FROM schema_migration_files ORDER BY file",
    );

    const beforeVersions = await readVersions();
    const beforeFiles = await readFiles();
    expect(beforeVersions.map(({ version }) => version)).toEqual(versions);
    expect(beforeFiles.map(({ file }) => file)).toEqual(files);
    expect(beforeFiles.map(({ file, version }) => ({ file, version }))).toEqual(
      files.map((file) => ({ file, version: Number.parseInt(file.slice(0, 3), 10) })),
    );

    await expect(runMigrations()).resolves.toBeUndefined();

    expect(await readVersions()).toEqual(beforeVersions);
    expect(await readFiles()).toEqual(beforeFiles);
    expect(await query("SELECT file FROM schema_migration_recovery_files")).toEqual([]);
  });
});
