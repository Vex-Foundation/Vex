/**
 * Shared Postgres migration runner — used by both the Vex Agent
 * (legacy entrypoint via src/vex-agent/db/migrate.ts) and the Electron
 * app (src/main/database/migrate-runner.ts which adds IPC plumbing).
 *
 * Lives under src/lib/ so it has zero root path-alias dependencies
 * (`@utils/...`, etc.). Vex-app's main tsconfig only includes
 * `vex-app/src/**` plus this `src/lib/**` carve-out, so importing
 * across the boundary stays build-safe.
 *
 * Concurrency safety: a Postgres advisory lock guards the whole run.
 * Concurrent processes (Electron main, maintenance scripts, integration
 * tests) are serialized — only one applies
 * migrations at a time.
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type pg from "pg";
import { HISTORICAL_MIGRATION_GROUPS } from "./migration-lineages.js";

/**
 * Stable advisory-lock identifier shared across every Vex consumer.
 * Pinning a single bigint lets concurrent installs/scripts queue on the
 * same lock instead of silently racing on schema_version.
 */
const VEX_MIGRATE_LOCK_ID = 1_985_229_328;

const DEFAULT_STATEMENT_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_LOCK_TIMEOUT_MS = 30_000;

/**
 * Thrown when a single migration's SQL execution fails. Preserves the
 * version/file context so callers (the IPC handler especially) can
 * surface `failedAt` without parsing log lines.
 */
export class MigrationError extends Error {
  public readonly version: number;
  public readonly file: string;
  // `override`: Error.cause exists in lib ES2022+; vex-app's typecheck
  // profile (noImplicitOverride) requires the modifier to be explicit.
  public override readonly cause: unknown;

  constructor(version: number, file: string, cause: unknown) {
    const causeMsg = cause instanceof Error ? cause.message : String(cause);
    super(`Migration ${file} (v${version}) failed: ${causeMsg}`);
    this.name = "MigrationError";
    this.version = version;
    this.file = file;
    this.cause = cause;
  }
}

/**
 * Thrown BEFORE anything is applied when the ledger skipped a migration this
 * directory still carries.
 *
 * WHY THE RUNNER REFUSES RATHER THAN REPAIRING. The cursor used to be
 * `MAX(version)`, which is correct for an immutable, strictly ordered release
 * history and silently wrong for a database that was touched by hand: measured
 * on the owner's development install 2026-09-06, 109 was applied manually before
 * 108 existed, and every later run reported "up to date" while 108 was missing
 * for good. Replaying the missing files automatically is NOT the fix. These
 * migrations restate named CHECK constraints in full (107 and 108 both restate
 * `agent_activity_event_role_valid`), so applying an older file on top of a
 * newer schema would silently narrow a constraint a later migration widened.
 * A gap is therefore a REPAIR DECISION a person makes, and the runner's job is
 * to name it exactly and stop.
 *
 * A ledger version this build has no file for is NOT a gap: that database was
 * migrated by a newer build, and an older binary correctly has nothing to do.
 * Neither is a hole in the directory's own numbering (this repository has one:
 * 103, 104 and 105 were never authored) - only a file whose version sits below
 * the applied high-water mark and is absent from `schema_version` counts.
 */
export class MigrationLedgerGapError extends Error {
  /** The migrations this directory carries that the ledger never recorded, ascending. */
  public readonly missing: ReadonlyArray<PendingMigration>;
  /** The highest version `schema_version` does record. */
  public readonly appliedThrough: number;

  constructor(missing: ReadonlyArray<PendingMigration>, appliedThrough: number) {
    const named = missing.map((m) => `${m.file} (v${m.version})`).join(", ");
    super(
      `Migration ledger gap: ${named} ` +
        `${missing.length === 1 ? "is" : "are"} missing from schema_version although ` +
        `v${appliedThrough} is already applied. Vex will not migrate this database: ` +
        `re-running an older migration on a newer schema can restate a CHECK constraint ` +
        `and undo a later change, so the repair is explicit. Apply the named file(s) by ` +
        `hand, verify the result, insert the matching schema_version row(s), and start ` +
        `Vex again - or restore a backup taken before the ledger diverged.`
    );
    this.name = "MigrationLedgerGapError";
    this.missing = missing;
    this.appliedThrough = appliedThrough;
  }
}

export interface MigrationProgressEvent {
  /**
   * - `planned`: emitted once at the start with `total` set to the count
   *   of pending migrations. `version` and `file` are unused (0 / "").
   * - `start`: emitted before each migration's SQL execution.
   * - `applied`: emitted after the migration commits successfully.
   */
  readonly phase: "planned" | "start" | "applied";
  readonly index: number;
  readonly total: number;
  readonly version: number;
  readonly file: string;
}

export interface RunMigrationsOptions {
  readonly pool: pg.Pool;
  readonly migrationsDir: string;
  readonly onProgress?: (event: MigrationProgressEvent) => void;
  readonly statementTimeoutMs?: number;
  readonly lockTimeoutMs?: number;
}

export interface RunMigrationsResult {
  readonly applied: number;
  readonly files: ReadonlyArray<string>;
}

interface PendingMigration {
  readonly version: number;
  readonly file: string;
}

/** Every `NNN_*.sql` this directory carries, ascending by version. */
function listMigrations(migrationsDir: string): ReadonlyArray<PendingMigration> {
  return readdirSync(migrationsDir)
    .filter((file) => /^\d{3}_.*\.sql$/.test(file))
    .sort()
    .map((file) => ({ version: Number.parseInt(file.slice(0, 3), 10), file }));
}

function listPendingMigrations(
  migrations: ReadonlyArray<PendingMigration>,
  currentVersion: number,
  appliedFiles: ReadonlySet<string>,
  recoveryFiles: ReadonlySet<string>,
  legacyVersion: number,
): ReadonlyArray<PendingMigration> {
  const filesByVersion = new Map<number, string[]>();
  for (const migration of migrations) {
    const siblings = filesByVersion.get(migration.version) ?? [];
    siblings.push(migration.file);
    filesByVersion.set(migration.version, siblings);
  }

  return migrations.filter((migration) => {
    if (appliedFiles.has(migration.file)) return false;
    if (recoveryFiles.has(migration.file)) return true;
    if (migration.version > currentVersion) return true;
    if (migration.version <= legacyVersion) return false;

    // A run may stop after committing the first file in a duplicate-prefix
    // group. Its numeric version is then already current, but the filename
    // ledger tells us which sibling still needs to run. Legacy databases have
    // no filename entries, so they continue to skip old numeric history and
    // receive any missing schema through a forward repair migration instead.
    const siblings = filesByVersion.get(migration.version) ?? [];
    return siblings.some((file) => appliedFiles.has(file));
  });
}

async function readLegacyVersion(
  client: pg.PoolClient, currentVersion: number, appliedFiles: ReadonlySet<string>,
): Promise<number> {
  const result = await client.query<{ legacy_version: number }>(
    "SELECT legacy_version FROM schema_migration_baseline WHERE singleton = TRUE",
  );
  const saved = result.rows[0];
  if (saved) return saved.legacy_version;
  // The exact ledger may have been introduced after many numeric migrations.
  // Freeze that boundary before recording any recovered low-numbered files;
  // otherwise a later run could mistake their already-shipped siblings for new
  // work and replay old, narrower constraints over current user data.
  const versions = [...appliedFiles].map((file) => Number.parseInt(file.slice(0, 3), 10));
  const legacyVersion = versions.length === 0 ? currentVersion : Math.max(0, Math.min(...versions) - 1);
  await client.query(
    "INSERT INTO schema_migration_baseline (singleton, legacy_version) VALUES (TRUE, $1)", [legacyVersion],
  );
  return legacyVersion;
}

/** Plan missing lineages before any dependent migration can advance the version. */
async function planHistoricalRecovery(
  client: pg.PoolClient,
  migrations: ReadonlyArray<PendingMigration>,
  currentVersion: number,
  appliedFiles: ReadonlySet<string>,
): Promise<ReadonlySet<string>> {
  const eligibleFiles = new Set(migrations
    .filter(({ file, version }) => version <= currentVersion && !appliedFiles.has(file))
    .map(({ file }) => file));
  for (const group of HISTORICAL_MIGRATION_GROUPS) {
    const files = group.files.filter((file) => eligibleFiles.has(file));
    if (files.length === 0) continue;
    const result = await client.query<{ present: boolean }>(
      "SELECT to_regclass($1) IS NOT NULL AS present", [group.table],
    );
    // Existing tables may contain newer data and constraints. Never replay an
    // old foundation merely because a legacy database has no filename ledger.
    if (result.rows[0]?.present !== false) continue;
    await client.query(
      "INSERT INTO schema_migration_recovery_files (file) SELECT unnest($1::text[]) ON CONFLICT DO NOTHING",
      [files],
    );
  }
  const result = await client.query<{ file: string }>("SELECT file FROM schema_migration_recovery_files");
  const availableFiles = new Set(migrations.map(({ file }) => file));
  for (const { file } of result.rows) {
    if (!availableFiles.has(file)) throw new Error(`Required migration recovery file is missing: ${file}`);
  }
  return new Set(result.rows.map(({ file }) => file));
}

/**
 * The whole ledger, not its maximum. The set is what makes a gap visible; the
 * maximum alone cannot distinguish "108 was never applied" from "108 does not
 * exist yet".
 */
async function readAppliedVersions(client: pg.PoolClient): Promise<ReadonlySet<number>> {
  const result = await client.query<{ version: number }>(
    "SELECT version FROM schema_version ORDER BY version ASC"
  );
  return new Set(result.rows.map((row) => Number(row.version)));
}

/**
 * The migrations this directory carries that the ledger skipped: below the
 * applied high-water mark and absent from `schema_version`. Empty ledger means
 * a fresh database, where nothing can be skipped.
 */
function ledgerGaps(
  files: ReadonlyArray<PendingMigration>,
  applied: ReadonlySet<number>
): ReadonlyArray<PendingMigration> {
  if (applied.size === 0) return [];
  const appliedThrough = Math.max(...applied);
  return files.filter((m) => m.version < appliedThrough && !applied.has(m.version));
}

async function readAppliedFiles(
  client: pg.PoolClient
): Promise<ReadonlySet<string>> {
  const result = await client.query<{ file: string }>(
    "SELECT file FROM schema_migration_files"
  );
  return new Set(result.rows.map((row) => row.file));
}

async function ensureSchemaVersionTable(client: pg.PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  // Keep the shipped numeric table intact for compatibility with existing
  // installs and operational queries. Exact filenames live in a companion
  // ledger because historical migrations 079-084 contain duplicate numeric
  // prefixes that cannot both be represented by version INTEGER PRIMARY KEY.
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migration_files (
      file TEXT PRIMARY KEY,
      version INTEGER NOT NULL,
      applied_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  // Persist the exact recovery plan before creating the first missing table.
  // A restart must finish the remaining columns even after that table exists.
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migration_recovery_files (
      file TEXT PRIMARY KEY
    )
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migration_baseline (
      singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
      legacy_version INTEGER NOT NULL CHECK (legacy_version >= 0)
    )
  `);
}

async function applyMigration(
  client: pg.PoolClient,
  migration: PendingMigration,
  migrationsDir: string
): Promise<void> {
  const sql = readFileSync(path.join(migrationsDir, migration.file), "utf-8");
  try {
    await client.query("BEGIN");
    await client.query(sql);
    await client.query(
      "INSERT INTO schema_version (version) VALUES ($1) ON CONFLICT (version) DO NOTHING",
      [migration.version]
    );
    await client.query(
      "INSERT INTO schema_migration_files (file, version) VALUES ($1, $2)",
      [migration.file, migration.version]
    );
    await client.query("DELETE FROM schema_migration_recovery_files WHERE file = $1", [migration.file]);
    await client.query("COMMIT");
  } catch (cause: unknown) {
    // ROLLBACK is best-effort — if the connection itself died we cannot
    // do anything sensible; the throw below carries the original cause.
    try {
      await client.query("ROLLBACK");
    } catch {
      /* ignore */
    }
    throw new MigrationError(migration.version, migration.file, cause);
  }
}

export async function runMigrationsWithProgress(
  options: RunMigrationsOptions
): Promise<RunMigrationsResult> {
  const statementTimeoutMs =
    options.statementTimeoutMs ?? DEFAULT_STATEMENT_TIMEOUT_MS;
  const lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;

  const client = await options.pool.connect();
  let lockAcquired = false;
  try {
    // lock_timeout governs both relation locks AND advisory lock acquisition.
    // Set BEFORE asking for the lock so we fail fast instead of blocking
    // forever behind another in-flight migration.
    await client.query(`SET lock_timeout = ${lockTimeoutMs}`);
    await client.query("SELECT pg_advisory_lock($1::bigint)", [
      VEX_MIGRATE_LOCK_ID,
    ]);
    lockAcquired = true;

    // statement_timeout caps each individual SQL statement (e.g. a
    // CREATE INDEX inside one of the migration files). Set AFTER the
    // advisory lock so the lock acquisition isn't capped by it.
    await client.query(`SET statement_timeout = ${statementTimeoutMs}`);

    await ensureSchemaVersionTable(client);
    const applied = await readAppliedVersions(client);
    const migrations = listMigrations(options.migrationsDir);
    const currentVersion = applied.size === 0 ? 0 : Math.max(...applied);
    const recordedFiles = await readAppliedFiles(client);
    const legacyVersion = await readLegacyVersion(client, currentVersion, recordedFiles);
    const recoveryFiles = await planHistoricalRecovery(client, migrations, currentVersion, recordedFiles);

    // Fail closed BEFORE the first BEGIN: a database with a hole in its ledger
    // is not a database this runner may keep migrating forward - UNLESS every
    // missing version is already covered by historical recovery (its table
    // does not exist yet, so recovery already plans to apply it). Without this
    // exemption, an install whose OWN numbering legitimately skips a version
    // (this repo's main lineage has no 103-105) trips a false gap the moment a
    // sibling branch's real file lands at that number.
    const gaps = ledgerGaps(migrations, applied).filter((m) => !recoveryFiles.has(m.file));
    if (gaps.length > 0) {
      throw new MigrationLedgerGapError(gaps, currentVersion);
    }

    const pending = listPendingMigrations(
      migrations,
      currentVersion,
      recordedFiles,
      recoveryFiles,
      legacyVersion,
    );

    options.onProgress?.({
      phase: "planned",
      index: 0,
      total: pending.length,
      version: 0,
      file: "",
    });

    const appliedFiles: string[] = [];
    for (let i = 0; i < pending.length; i += 1) {
      const migration = pending[i];
      if (migration === undefined) continue; // satisfies noUncheckedIndexedAccess
      options.onProgress?.({
        phase: "start",
        index: i,
        total: pending.length,
        version: migration.version,
        file: migration.file,
      });

      await applyMigration(client, migration, options.migrationsDir);
      appliedFiles.push(migration.file);

      options.onProgress?.({
        phase: "applied",
        index: i,
        total: pending.length,
        version: migration.version,
        file: migration.file,
      });
    }

    return {
      applied: appliedFiles.length,
      files: appliedFiles,
    };
  } finally {
    let unlockFailed = false;
    if (lockAcquired) {
      // Best-effort unlock — if the session is dying the lock is auto-
      // released when the connection closes anyway.
      try {
        await client.query("SELECT pg_advisory_unlock($1::bigint)", [
          VEX_MIGRATE_LOCK_ID,
        ]);
      } catch {
        unlockFailed = true;
      }
    }
    // Reset session settings so the next consumer of this pooled client
    // (engine refactor passes a shared pool) gets defaults. NOTE that
    // `RESET ALL` does NOT release session-level advisory locks — only
    // `pg_advisory_unlock` or session disconnect does.
    try {
      await client.query("RESET ALL");
    } catch {
      /* ignore */
    }
    if (unlockFailed) {
      // The session may still hold the advisory lock. Returning the
      // client to the pool would let the next consumer re-acquire its
      // own connection that already owns the lock, deadlocking every
      // future migrate run. Force-destroy by passing a truthy arg so
      // pg-pool removes this client from the pool (codex turn 2
      // should-fix #5).
      client.release(
        new Error("migrate-runner: pg_advisory_unlock failed; destroying client")
      );
    } else {
      client.release();
    }
  }
}
