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

function listPendingMigrations(
  migrationsDir: string,
  currentVersion: number,
  appliedFiles: ReadonlySet<string>
): ReadonlyArray<PendingMigration> {
  const migrations = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql") && /^\d{3}_/.test(f))
    .sort()
    .map((file) => ({ version: parseInt(file.slice(0, 3), 10), file }));

  const filesByVersion = new Map<number, string[]>();
  for (const migration of migrations) {
    const siblings = filesByVersion.get(migration.version) ?? [];
    siblings.push(migration.file);
    filesByVersion.set(migration.version, siblings);
  }

  return migrations.filter((migration) => {
    if (appliedFiles.has(migration.file)) return false;
    if (migration.version > currentVersion) return true;

    // A run may stop after committing the first file in a duplicate-prefix
    // group. Its numeric version is then already current, but the filename
    // ledger tells us which sibling still needs to run. Legacy databases have
    // no filename entries, so they continue to skip old numeric history and
    // receive any missing schema through a forward repair migration instead.
    const siblings = filesByVersion.get(migration.version) ?? [];
    return siblings.some((file) => appliedFiles.has(file));
  });
}

async function readCurrentVersion(client: pg.PoolClient): Promise<number> {
  const result = await client.query<{ version: number }>(
    "SELECT COALESCE(MAX(version), 0) AS version FROM schema_version"
  );
  return result.rows[0]?.version ?? 0;
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
    const currentVersion = await readCurrentVersion(client);
    const recordedFiles = await readAppliedFiles(client);
    const pending = listPendingMigrations(
      options.migrationsDir,
      currentVersion,
      recordedFiles
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
