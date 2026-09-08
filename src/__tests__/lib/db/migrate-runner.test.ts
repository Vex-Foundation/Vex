/**
 * Direct tests for the shared migration runner. Codex turn 2 flagged
 * that the engine + vex-app suites both mock this module — the lock
 * sequencing, rollback path, MigrationError shape, and unlock-failure
 * handling were the most important new logic and were under-tested.
 *
 * These tests run with a controllable mock pg.Pool/PoolClient so we
 * can assert the exact SQL call sequence + verify error paths.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type pg from "pg";
import {
  MigrationError,
  MigrationLedgerGapError,
  runMigrationsWithProgress,
  type MigrationProgressEvent,
} from "../../../lib/db/migrate-runner.js";

interface ClientCall {
  readonly sql: string;
  readonly params: unknown[] | undefined;
}

interface MockClient {
  readonly calls: ClientCall[];
  readonly release: ReturnType<typeof vi.fn>;
  setQueryImpl: (
    fn: (sql: string, params: unknown[] | undefined) => Promise<unknown>
  ) => void;
}

/** The runner's ledger read: every applied version, not just the maximum. */
const APPLIED_VERSIONS_QUERY = /SELECT version\s+FROM schema_version/i;

interface MockPool {
  readonly pool: pg.Pool;
  readonly client: MockClient;
}

/**
 * Build a mock pg.Pool whose `connect()` resolves to a single
 * controllable client. `setQueryImpl` overrides the default query
 * dispatcher per test.
 *
 * `currentVersion` describes the ordinary CONTIGUOUS ledger 1..n, which is what
 * every pre-existing test here means by it. `ledger` states the applied rows
 * exactly, and is how the gap tests describe a database that skipped one.
 */
function makeMockPool(
  currentVersion = 0,
  appliedFilesOrLedger?: readonly string[] | readonly number[]
): MockPool {
  // Callers pass either the exact filenames recorded in schema_migration_files
  // (the file-ledger / historical-recovery tests) or an explicit, possibly
  // non-contiguous, list of applied version numbers (the gap-detection tests).
  // Distinguish by element type; an omitted/empty argument defaults to the
  // ordinary contiguous ledger 1..currentVersion.
  const isLedger =
    appliedFilesOrLedger !== undefined &&
    appliedFilesOrLedger.every((value) => typeof value === "number");
  const ledger = isLedger ? (appliedFilesOrLedger as readonly number[]) : undefined;
  const appliedFiles = isLedger
    ? []
    : ((appliedFilesOrLedger as readonly string[] | undefined) ?? []);
  const appliedVersions =
    ledger ?? Array.from({ length: currentVersion }, (_, index) => index + 1);
  const calls: ClientCall[] = [];
  const defaultQueryImpl: (
    sql: string,
    params: unknown[] | undefined
  ) => Promise<unknown> = async (sql) => {
    if (APPLIED_VERSIONS_QUERY.test(sql)) {
      return { rows: appliedVersions.map((version) => ({ version })) };
    }
    if (/SELECT file FROM schema_migration_files/i.test(sql)) {
      return { rows: appliedFiles.map((file) => ({ file })) };
    }
    if (/SELECT file FROM schema_migration_recovery_files/i.test(sql)) return { rows: [] };
    if (/SELECT legacy_version FROM schema_migration_baseline/i.test(sql)) return { rows: [] };
    if (/SELECT to_regclass/i.test(sql)) return { rows: [{ present: true }] };
    return undefined;
  };
  let queryImpl = defaultQueryImpl;
  const release = vi.fn();
  const client = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      return queryImpl(sql, params);
    }),
    release,
  };
  const pool = {
    connect: vi.fn(async () => client),
  } as unknown as pg.Pool;
  return {
    pool,
    client: {
      calls,
      release,
      setQueryImpl: (fn) => {
        queryImpl = async (sql, params) => {
          const result = await fn(sql, params);
          return result ?? defaultQueryImpl(sql, params);
        };
      },
    },
  };
}

let tmpDir = "";

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "vex-shared-migrate-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function indexOfCall(
  calls: ClientCall[],
  pattern: RegExp
): number {
  return calls.findIndex((c) => pattern.test(c.sql));
}

describe("runMigrationsWithProgress — lock + timeout sequencing", () => {
  it("sets lock_timeout BEFORE acquiring advisory lock, statement_timeout AFTER", async () => {
    const { pool, client } = makeMockPool();
    await runMigrationsWithProgress({ pool, migrationsDir: tmpDir });

    const lockTimeoutIdx = indexOfCall(client.calls, /SET lock_timeout/i);
    const acquireIdx = indexOfCall(
      client.calls,
      /pg_advisory_lock\(\$1::bigint\)/i
    );
    const stmtTimeoutIdx = indexOfCall(
      client.calls,
      /SET statement_timeout/i
    );

    expect(lockTimeoutIdx).toBeGreaterThanOrEqual(0);
    expect(acquireIdx).toBeGreaterThanOrEqual(0);
    expect(stmtTimeoutIdx).toBeGreaterThanOrEqual(0);
    expect(lockTimeoutIdx).toBeLessThan(acquireIdx);
    expect(acquireIdx).toBeLessThan(stmtTimeoutIdx);
  });

  it("acquires the advisory lock BEFORE reading current schema version", async () => {
    const { pool, client } = makeMockPool();
    await runMigrationsWithProgress({ pool, migrationsDir: tmpDir });

    const acquireIdx = indexOfCall(
      client.calls,
      /pg_advisory_lock\(\$1::bigint\)/i
    );
    const versionReadIdx = indexOfCall(client.calls, APPLIED_VERSIONS_QUERY);
    expect(acquireIdx).toBeGreaterThanOrEqual(0);
    expect(versionReadIdx).toBeGreaterThan(acquireIdx);
  });

  it("uses the configured lockTimeoutMs and statementTimeoutMs", async () => {
    const { pool, client } = makeMockPool();
    await runMigrationsWithProgress({
      pool,
      migrationsDir: tmpDir,
      lockTimeoutMs: 7_777,
      statementTimeoutMs: 88_888,
    });
    const lockCall = client.calls.find((c) => /SET lock_timeout/i.test(c.sql));
    const stmtCall = client.calls.find((c) =>
      /SET statement_timeout/i.test(c.sql)
    );
    expect(lockCall?.sql).toContain("7777");
    expect(stmtCall?.sql).toContain("88888");
  });
});

describe("runMigrationsWithProgress — applied + noop", () => {
  it("returns noop ({applied:0}) when no pending migrations", async () => {
    const { pool } = makeMockPool();
    const result = await runMigrationsWithProgress({
      pool,
      migrationsDir: tmpDir,
    });
    expect(result.applied).toBe(0);
    expect(result.files).toEqual([]);
  });

  it("applies each pending migration in order and returns count + files", async () => {
    writeFileSync(join(tmpDir, "001_initial.sql"), "CREATE TABLE a(id int);");
    writeFileSync(join(tmpDir, "002_second.sql"), "CREATE TABLE b(id int);");
    const { pool, client } = makeMockPool();

    const result = await runMigrationsWithProgress({
      pool,
      migrationsDir: tmpDir,
    });

    expect(result.applied).toBe(2);
    expect(result.files).toEqual(["001_initial.sql", "002_second.sql"]);
    // Verify both migrations ran inside their own BEGIN/COMMIT block.
    const beginCount = client.calls.filter((c) => c.sql === "BEGIN").length;
    const commitCount = client.calls.filter((c) => c.sql === "COMMIT").length;
    expect(beginCount).toBe(2);
    expect(commitCount).toBe(2);
    expect(
      client.calls.filter((c) =>
        /INSERT INTO schema_migration_files/i.test(c.sql)
      )
    ).toHaveLength(2);
  });

  it("applies every same-prefix file once without a numeric PK collision", async () => {
    writeFileSync(join(tmpDir, "079_alpha.sql"), "SELECT 'alpha';");
    writeFileSync(join(tmpDir, "079_beta.sql"), "SELECT 'beta';");
    const { pool, client } = makeMockPool(78);

    const result = await runMigrationsWithProgress({
      pool,
      migrationsDir: tmpDir,
    });

    expect(result.files).toEqual(["079_alpha.sql", "079_beta.sql"]);
    const numericInserts = client.calls.filter((c) =>
      /INSERT INTO schema_version/i.test(c.sql)
    );
    expect(numericInserts).toHaveLength(2);
    expect(numericInserts.every((c) => /ON CONFLICT/i.test(c.sql))).toBe(true);
    expect(numericInserts.map((c) => c.params)).toEqual([[79], [79]]);
    const fileInserts = client.calls.filter((c) =>
      /INSERT INTO schema_migration_files/i.test(c.sql)
    );
    expect(fileInserts.map((c) => c.params)).toEqual([
      ["079_alpha.sql", 79],
      ["079_beta.sql", 79],
    ]);
  });

  it("resumes an unrecorded sibling after one same-prefix file committed", async () => {
    writeFileSync(join(tmpDir, "079_alpha.sql"), "SELECT 'alpha';");
    writeFileSync(join(tmpDir, "079_beta.sql"), "SELECT 'beta';");
    const { pool } = makeMockPool(79, ["079_alpha.sql"]);

    const result = await runMigrationsWithProgress({
      pool,
      migrationsDir: tmpDir,
    });

    expect(result.files).toEqual(["079_beta.sql"]);
  });

  it("keeps legacy numeric history skipped and runs only its forward repair", async () => {
    writeFileSync(join(tmpDir, "079_alpha.sql"), "SELECT 'alpha';");
    writeFileSync(join(tmpDir, "079_beta.sql"), "SELECT 'beta';");
    writeFileSync(join(tmpDir, "109_collision_repair.sql"), "SELECT 'repair';");
    const { pool } = makeMockPool(108);

    const result = await runMigrationsWithProgress({
      pool,
      migrationsDir: tmpDir,
    });

    expect(result.files).toEqual(["109_collision_repair.sql"]);
  });

  it("emits planned/start/applied progress events with correct index/total", async () => {
    writeFileSync(join(tmpDir, "001_a.sql"), "CREATE TABLE a(id int);");
    writeFileSync(join(tmpDir, "002_b.sql"), "CREATE TABLE b(id int);");
    const { pool } = makeMockPool();

    const events: MigrationProgressEvent[] = [];
    await runMigrationsWithProgress({
      pool,
      migrationsDir: tmpDir,
      onProgress: (e) => events.push(e),
    });

    expect(events[0]).toMatchObject({ phase: "planned", total: 2 });
    expect(events[1]).toMatchObject({
      phase: "start",
      index: 0,
      total: 2,
      version: 1,
      file: "001_a.sql",
    });
    expect(events[2]).toMatchObject({
      phase: "applied",
      index: 0,
      total: 2,
      version: 1,
    });
    expect(events[3]).toMatchObject({
      phase: "start",
      index: 1,
      total: 2,
      version: 2,
      file: "002_b.sql",
    });
    expect(events[4]).toMatchObject({
      phase: "applied",
      index: 1,
      total: 2,
      version: 2,
    });
  });

  it("skips migrations whose version is <= currentVersion", async () => {
    writeFileSync(join(tmpDir, "001_a.sql"), "select 1");
    writeFileSync(join(tmpDir, "002_b.sql"), "select 2");
    writeFileSync(join(tmpDir, "003_c.sql"), "select 3");
    const { pool } = makeMockPool(2);

    const result = await runMigrationsWithProgress({
      pool,
      migrationsDir: tmpDir,
    });
    expect(result.applied).toBe(1);
    expect(result.files).toEqual(["003_c.sql"]);
  });
});

describe("runMigrationsWithProgress — failure paths", () => {
  it("rolls back the transaction when the migration SQL throws", async () => {
    writeFileSync(join(tmpDir, "001_bad.sql"), "INVALID SQL;");
    const { pool, client } = makeMockPool();

    client.setQueryImpl(async (sql) => {
      if (APPLIED_VERSIONS_QUERY.test(sql)) {
        return { rows: [] };
      }
      if (sql === "INVALID SQL;") {
        throw new Error("syntax error at or near INVALID");
      }
      return undefined;
    });

    await expect(
      runMigrationsWithProgress({ pool, migrationsDir: tmpDir })
    ).rejects.toBeInstanceOf(MigrationError);

    expect(client.calls.some((c) => c.sql === "ROLLBACK")).toBe(true);
    expect(client.calls.some((c) => c.sql === "COMMIT")).toBe(false);
  });

  it("throws MigrationError carrying version + file + cause", async () => {
    writeFileSync(join(tmpDir, "007_bad.sql"), "BOOM;");
    const { pool, client } = makeMockPool();
    const cause = new Error("syntax error");

    client.setQueryImpl(async (sql) => {
      if (APPLIED_VERSIONS_QUERY.test(sql)) {
        return { rows: [] };
      }
      if (sql === "BOOM;") {
        throw cause;
      }
      return undefined;
    });

    try {
      await runMigrationsWithProgress({ pool, migrationsDir: tmpDir });
      expect.fail("should have thrown");
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(MigrationError);
      const me = err as MigrationError;
      expect(me.version).toBe(7);
      expect(me.file).toBe("007_bad.sql");
      expect(me.cause).toBe(cause);
      expect(me.name).toBe("MigrationError");
    }
  });

  it("releases the advisory lock + RESET ALL even after a migration failure", async () => {
    writeFileSync(join(tmpDir, "001_bad.sql"), "BOOM;");
    const { pool, client } = makeMockPool();

    client.setQueryImpl(async (sql) => {
      if (APPLIED_VERSIONS_QUERY.test(sql)) {
        return { rows: [] };
      }
      if (sql === "BOOM;") {
        throw new Error("oops");
      }
      return undefined;
    });

    await expect(
      runMigrationsWithProgress({ pool, migrationsDir: tmpDir })
    ).rejects.toBeInstanceOf(MigrationError);

    const unlockIdx = indexOfCall(
      client.calls,
      /pg_advisory_unlock\(\$1::bigint\)/i
    );
    const resetIdx = indexOfCall(client.calls, /^RESET ALL$/i);
    expect(unlockIdx).toBeGreaterThanOrEqual(0);
    expect(resetIdx).toBeGreaterThan(unlockIdx);
    expect(client.release).toHaveBeenCalledTimes(1);
    // Plain release (no truthy arg) — this is a normal failure path,
    // not the unlock-failure path.
    expect(client.release.mock.calls[0]?.[0]).toBeUndefined();
  });
});

describe("runMigrationsWithProgress — unlock failure handling", () => {
  it("destroys the client when pg_advisory_unlock fails", async () => {
    const { pool, client } = makeMockPool();

    client.setQueryImpl(async (sql) => {
      if (APPLIED_VERSIONS_QUERY.test(sql)) {
        return { rows: [] };
      }
      if (/pg_advisory_unlock\(\$1::bigint\)/i.test(sql)) {
        throw new Error("connection lost during unlock");
      }
      return undefined;
    });

    await runMigrationsWithProgress({ pool, migrationsDir: tmpDir });

    expect(client.release).toHaveBeenCalledTimes(1);
    // release was called with truthy (Error) → pg-pool destroys the
    // client instead of returning it to the pool.
    const arg = client.release.mock.calls[0]?.[0];
    expect(arg).toBeInstanceOf(Error);
    expect((arg as Error).message).toContain("pg_advisory_unlock failed");
  });

  it("does NOT destroy the client on a normal successful run", async () => {
    const { pool, client } = makeMockPool();
    await runMigrationsWithProgress({ pool, migrationsDir: tmpDir });
    expect(client.release).toHaveBeenCalledTimes(1);
    expect(client.release.mock.calls[0]?.[0]).toBeUndefined();
  });
});

/**
 * THE LEDGER GAP THE `MAX(version)` CURSOR SILENTLY ACCEPTED.
 *
 * Measured on the owner's development database 2026-09-06: 109 was applied by
 * hand before 108 existed, the cursor read 109, and 108 was skipped forever
 * (`launchpads.plan.md` section 9, "DEV DB HAZARD"). Every later run reported
 * "up to date" against a schema that was missing a migration.
 *
 * The runner now refuses instead, and refuses BEFORE applying anything: Codex's
 * answer to the question the arc posed is that an automatic replay is the wrong
 * repair, because an older migration can restate a CHECK constraint and undo a
 * later one. So the runner names the missing versions and stops; a human
 * repairs the ledger explicitly.
 */
describe("runMigrationsWithProgress - ledger gap detection", () => {
  it("refuses and names the missing version when the ledger skipped one below MAX", async () => {
    writeFileSync(join(tmpDir, "107_a.sql"), "select 107");
    writeFileSync(join(tmpDir, "108_b.sql"), "select 108");
    writeFileSync(join(tmpDir, "109_c.sql"), "select 109");
    const { pool, client } = makeMockPool(0, [107, 109]);

    await expect(
      runMigrationsWithProgress({ pool, migrationsDir: tmpDir })
    ).rejects.toBeInstanceOf(MigrationLedgerGapError);

    // Nothing was applied: the refusal is a precondition, not a partial run.
    expect(client.calls.some((c) => c.sql === "BEGIN")).toBe(false);
    expect(client.calls.some((c) => /INSERT INTO schema_version/i.test(c.sql))).toBe(false);
  });

  it("carries the missing versions, the applied high-water mark and a repair instruction", async () => {
    writeFileSync(join(tmpDir, "106_a.sql"), "select 106");
    writeFileSync(join(tmpDir, "107_b.sql"), "select 107");
    writeFileSync(join(tmpDir, "108_c.sql"), "select 108");
    writeFileSync(join(tmpDir, "109_d.sql"), "select 109");
    const { pool } = makeMockPool(0, [106, 109]);

    try {
      await runMigrationsWithProgress({ pool, migrationsDir: tmpDir });
      expect.fail("should have thrown");
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(MigrationLedgerGapError);
      const gap = err as MigrationLedgerGapError;
      expect(gap.name).toBe("MigrationLedgerGapError");
      expect(gap.missing).toEqual([
        { version: 107, file: "107_b.sql" },
        { version: 108, file: "108_c.sql" },
      ]);
      expect(gap.appliedThrough).toBe(109);
      // The operator has to be able to act on the message alone.
      expect(gap.message).toContain("107_b.sql");
      expect(gap.message).toContain("108_c.sql");
      expect(gap.message).toContain("schema_version");
    }
  });

  it("still releases the advisory lock and resets the session after refusing", async () => {
    writeFileSync(join(tmpDir, "001_a.sql"), "select 1");
    writeFileSync(join(tmpDir, "002_b.sql"), "select 2");
    const { pool, client } = makeMockPool(0, [2]);

    await expect(
      runMigrationsWithProgress({ pool, migrationsDir: tmpDir })
    ).rejects.toBeInstanceOf(MigrationLedgerGapError);

    const unlockIdx = indexOfCall(client.calls, /pg_advisory_unlock\(\$1::bigint\)/i);
    const resetIdx = indexOfCall(client.calls, /^RESET ALL$/i);
    expect(unlockIdx).toBeGreaterThanOrEqual(0);
    expect(resetIdx).toBeGreaterThan(unlockIdx);
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it("a contiguous ledger applies the rest in order", async () => {
    writeFileSync(join(tmpDir, "107_a.sql"), "select 107");
    writeFileSync(join(tmpDir, "108_b.sql"), "select 108");
    writeFileSync(join(tmpDir, "109_c.sql"), "select 109");
    const { pool } = makeMockPool(0, [107, 108]);

    const result = await runMigrationsWithProgress({ pool, migrationsDir: tmpDir });
    expect(result.files).toEqual(["109_c.sql"]);
  });

  it("an empty ledger applies everything in order", async () => {
    writeFileSync(join(tmpDir, "107_a.sql"), "select 107");
    writeFileSync(join(tmpDir, "108_b.sql"), "select 108");
    writeFileSync(join(tmpDir, "109_c.sql"), "select 109");
    const { pool } = makeMockPool(0, []);

    const result = await runMigrationsWithProgress({ pool, migrationsDir: tmpDir });
    expect(result.files).toEqual(["107_a.sql", "108_b.sql", "109_c.sql"]);
  });

  /**
   * A hole in the FILES is not a hole in the ledger. This repository has one
   * (103, 104 and 105 were never authored), so a rule written as
   * "every integer below MAX must be present" would refuse every install.
   */
  it("accepts a ledger matching a directory whose own numbering has holes", async () => {
    writeFileSync(join(tmpDir, "102_a.sql"), "select 102");
    writeFileSync(join(tmpDir, "106_b.sql"), "select 106");
    writeFileSync(join(tmpDir, "107_c.sql"), "select 107");
    const { pool } = makeMockPool(0, [102, 106]);

    const result = await runMigrationsWithProgress({ pool, migrationsDir: tmpDir });
    expect(result.files).toEqual(["107_c.sql"]);
  });

  /**
   * A ledger version this build has no file for means the database was migrated
   * by a NEWER build. That is not a gap and must not refuse: the older binary
   * simply has nothing to apply.
   */
  it("does not refuse when the ledger is ahead of the directory", async () => {
    writeFileSync(join(tmpDir, "107_a.sql"), "select 107");
    const { pool } = makeMockPool(0, [107, 108, 109]);

    const result = await runMigrationsWithProgress({ pool, migrationsDir: tmpDir });
    expect(result.applied).toBe(0);
  });
});
