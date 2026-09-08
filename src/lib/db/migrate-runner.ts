/**
 * Shared Postgres migration runner - used by both the Vex Agent
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
 * tests) are serialized - only one applies migrations at a time.
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

/**
 * The three durable tables the branch-era runner created for its filename
 * "lineage" ledger. This build has no reader for them; their presence is proof
 * the database was migrated by a branch build.
 */
const BRANCH_ERA_LEDGER_TABLES = [
  "schema_migration_files",
  "schema_migration_recovery_files",
  "schema_migration_baseline",
] as const;

/** The positive marker migration 112 creates. See that file for the reasoning. */
const LIGHTER_SCHEMA_MARKER_TABLE = "lighter_schema_marker";
/** The one value the marker may hold under this numbering. */
const LIGHTER_SCHEMA_MARKER_LINEAGE = "main-2026-09";

/**
 * Visible tables that decide the question, in one round trip: every
 * `lighter_%` table plus the three branch-era ledger tables. Restricted to
 * `pg_table_is_visible` so it answers for the search_path this session will
 * actually migrate, not for every schema in the cluster. `\_` escapes the LIKE
 * wildcard so a table called `lighterx` cannot masquerade as a Lighter table.
 */
const BRANCH_ERA_DISCRIMINATOR_QUERY = `
    SELECT c.relname AS table_name
      FROM pg_class c
     WHERE c.relkind IN ('r', 'p')
       AND pg_table_is_visible(c.oid)
       AND (
         c.relname LIKE 'lighter\\_%'
         OR c.relname IN (
           'schema_migration_files',
           'schema_migration_recovery_files',
           'schema_migration_baseline'
         )
       )
`;

/** Why a database was refused. Each value names a distinct measured shape. */
export type MigrationBranchEraReason =
  /** One or more of the branch-era lineage ledger tables exists. */
  | "lineage_tables"
  /** Lighter tables exist but the marker migration 112 never ran. */
  | "unmarked_lighter_tables"
  /** The marker exists but does not hold exactly the one expected row. */
  | "unexpected_marker";

/**
 * Thrown BEFORE anything is read or written beyond the discriminator, when the
 * database was migrated by a build from the Lighter development branch.
 *
 * WHY THIS CANNOT BE A FORWARD MIGRATION. On that branch the Lighter files
 * occupied 079..120, numbers main had already spent on unrelated migrations. A
 * branch-era database therefore records, say, version 102 for
 * `lighter_core_withdrawals` while this build's 102 is
 * `portfolio_snapshot_group_wallets`. Both histories look identical in
 * `schema_version`: an integer high-water mark. Replaying forward from it would
 * run the wrong SQL against a schema that already has those tables, and running
 * an older file over a newer schema can restate a CHECK constraint and undo a
 * later change (the same hazard `MigrationLedgerGapError` names).
 *
 * The discriminator is therefore POSITIVE, not numeric: migration 112 creates
 * `lighter_schema_marker` before any Lighter table under this numbering, so a
 * database migrated by this build always carries it and a branch-era database
 * never can - including the numeric-only variant written by branch runners
 * before the lineage ledger existed. No build with the branch numbering was
 * ever distributed, so the only databases in this state are developer installs.
 *
 * Vex neither deletes nor converts such a database. The user backs it up and
 * recreates it; the error says exactly that.
 */
export class MigrationBranchEraDatabaseError extends Error {
  public readonly reason: MigrationBranchEraReason;
  /** The observed table names, or the observed marker rows, that decided it. */
  public readonly evidence: ReadonlyArray<string>;

  constructor(reason: MigrationBranchEraReason, evidence: ReadonlyArray<string>) {
    const named = evidence.length > 0 ? evidence.join(", ") : "(none)";
    const cause =
      reason === "lineage_tables"
        ? `it carries the pre-release migration ledger tables ${named}, which this build never creates`
        : reason === "unmarked_lighter_tables"
          ? `it carries Lighter tables (${named}) but not ${LIGHTER_SCHEMA_MARKER_TABLE}, so they were created by pre-release migration numbers this build assigns to different files`
          : `${LIGHTER_SCHEMA_MARKER_TABLE} does not hold exactly one row with lineage '${LIGHTER_SCHEMA_MARKER_LINEAGE}' (found: ${named})`;
    super(
      `Migration refused: this database was created by a pre-release Vex build - ${cause}. ` +
        `Replaying this build's migrations over it would run the wrong file against an existing table, ` +
        `so Vex stops instead. Vex will never delete or convert this database: back up anything you ` +
        `need from it, then recreate the local Vex database and start Vex again.`
    );
    this.name = "MigrationBranchEraDatabaseError";
    this.reason = reason;
    this.evidence = evidence;
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
function listMigrationFiles(migrationsDir: string): ReadonlyArray<PendingMigration> {
  return readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql") && /^\d{3}_/.test(f))
    .sort()
    .map((file) => ({ version: parseInt(file.slice(0, 3), 10), file }));
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

/**
 * Refuse a branch-era database before the run takes its first write.
 *
 * Runs under the advisory lock the caller already holds and BEFORE
 * `ensureSchemaVersionTable`, so a refused database is left exactly as found.
 * A fresh database and a main-only database both fall through: neither has a
 * `lighter_%` table nor a lineage table.
 */
async function assertNotBranchEraDatabase(client: pg.PoolClient): Promise<void> {
  const result = await client.query<{ table_name: string }>(
    BRANCH_ERA_DISCRIMINATOR_QUERY
  );
  const present = new Set(result.rows.map((row) => row.table_name));

  const lineageTables = BRANCH_ERA_LEDGER_TABLES.filter((table) =>
    present.has(table)
  );
  if (lineageTables.length > 0) {
    throw new MigrationBranchEraDatabaseError("lineage_tables", lineageTables);
  }

  const lighterTables = [...present]
    .filter((table) => table.startsWith("lighter_"))
    .sort();
  if (lighterTables.length === 0) return;

  if (!present.has(LIGHTER_SCHEMA_MARKER_TABLE)) {
    throw new MigrationBranchEraDatabaseError(
      "unmarked_lighter_tables",
      lighterTables
    );
  }

  const marker = await client.query<{ lineage: string }>(
    `SELECT lineage FROM ${LIGHTER_SCHEMA_MARKER_TABLE} ORDER BY lineage ASC`
  );
  const lineages = marker.rows.map((row) => row.lineage);
  if (
    lineages.length !== 1 ||
    lineages[0] !== LIGHTER_SCHEMA_MARKER_LINEAGE
  ) {
    throw new MigrationBranchEraDatabaseError("unexpected_marker", lineages);
  }
}

async function ensureSchemaVersionTable(client: pg.PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
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
      "INSERT INTO schema_version (version) VALUES ($1)",
      [migration.version]
    );
    await client.query("COMMIT");
  } catch (cause: unknown) {
    // ROLLBACK is best-effort - if the connection itself died we cannot
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

    // Fail closed before the first write of any kind, including the
    // schema_version CREATE TABLE: a database this runner may not migrate is
    // left byte-identical to how it was found.
    await assertNotBranchEraDatabase(client);

    await ensureSchemaVersionTable(client);
    const applied = await readAppliedVersions(client);
    const files = listMigrationFiles(options.migrationsDir);

    // Fail closed BEFORE the first BEGIN: a database with a hole in its ledger
    // is not a database this runner may keep migrating forward.
    const gaps = ledgerGaps(files, applied);
    if (gaps.length > 0) {
      throw new MigrationLedgerGapError(gaps, Math.max(...applied));
    }

    const currentVersion = applied.size === 0 ? 0 : Math.max(...applied);
    const pending = files.filter((m) => m.version > currentVersion);

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
      // Best-effort unlock - if the session is dying the lock is auto-
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
    // `RESET ALL` does NOT release session-level advisory locks - only
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
