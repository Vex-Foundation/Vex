import { randomUUID } from "node:crypto";
import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { runMigrationsWithProgress } from "../../../lib/db/migrate-runner.js";

const SOURCE = path.resolve("src/vex-agent/db/migrations");
const ALL_FILES = readdirSync(SOURCE).filter((file) => /^\d{3}_.*\.sql$/.test(file)).sort();
const rawMainFiles: unknown = JSON.parse(readFileSync(
  new URL("./fixtures/main-before-lighter.json", import.meta.url), "utf8",
));
if (!Array.isArray(rawMainFiles) || !rawMainFiles.every((file): file is string => typeof file === "string")) {
  throw new Error("Invalid main migration fixture");
}
const MAIN_FILES: string[] = rawMainFiles;

async function withDatabase(run: (pool: pg.Pool, staging: string) => Promise<void>): Promise<void> {
  const base = process.env.VEX_DB_URL;
  if (!base) throw new Error("The isolated PostgreSQL setup is required");
  const database = `lighter_upgrade_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Pool({ connectionString: base });
  const staging = mkdtempSync(path.join(tmpdir(), "lighter-upgrade-"));
  let pool: pg.Pool | undefined;
  try {
    await admin.query(`CREATE DATABASE ${database}`);
    const url = new URL(base);
    url.pathname = `/${database}`;
    pool = new pg.Pool({ connectionString: url.toString() });
    await run(pool, staging);
  } finally {
    await pool?.end();
    await admin.query(`DROP DATABASE IF EXISTS ${database}`);
    await admin.end();
    rmSync(staging, { recursive: true, force: true });
  }
}

function copyMigrations(files: readonly string[], staging: string): void {
  for (const file of files) copyFileSync(path.join(SOURCE, file), path.join(staging, file));
}

async function seedMainRecords(pool: pg.Pool): Promise<void> {
  await pool.query("INSERT INTO sessions (id) VALUES ('upgrade-session')");
  await pool.query(`INSERT INTO approval_queue (id, tool_call, reasoning, status, session_id)
    VALUES ('upgrade-approval', '{}'::jsonb, 'retained decision', 'pending', 'upgrade-session')`);
  await pool.query(`INSERT INTO protocol_executions (id, tool_id, namespace, success)
    VALUES (9001, 'wallet.transaction', 'wallet', false)`);
  await pool.query(`INSERT INTO agent_activity
    (protocol_execution_id, event_index, event_role, kind, protocol, chain_id, chain_family, wallet_address)
    VALUES
    (9001, 0, 'tx_contract_call', 'transaction', 'wallet', 1, 'eip155', '0x1111111111111111111111111111111111111111'),
    (9001, 1, 'creator_fee_claim', 'claim', 'virtuals', 8453, 'eip155', '0x1111111111111111111111111111111111111111')`);
}

async function retainedRecords(pool: pg.Pool): Promise<unknown> {
  return {
    approvals: (await pool.query("SELECT * FROM approval_queue ORDER BY id")).rows,
    activity: (await pool.query("SELECT * FROM agent_activity ORDER BY id")).rows,
  };
}

async function assertCompleted(pool: pg.Pool, staging: string): Promise<void> {
  for (const table of ["lighter_order_execution_intents", "lighter_onboarding_intents", "lighter_withdrawal_intents", "lighter_fee_authorization_intents"]) {
    expect((await pool.query("SELECT to_regclass($1)::text AS name", [table])).rows).toEqual([{ name: table }]);
  }
  expect((await pool.query("SELECT file FROM schema_migration_recovery_files")).rows).toEqual([]);
  expect(await runMigrationsWithProgress({ pool, migrationsDir: staging })).toEqual({ applied: 0, files: [] });
  const constraints = (await pool.query<{ definition: string }>(`SELECT pg_get_constraintdef(oid) AS definition
    FROM pg_constraint WHERE conrelid = 'agent_activity'::regclass AND conname = 'agent_activity_kind_role_binding'`)).rows;
  expect(constraints[0]?.definition).toContain("tx_contract_call");
  expect(constraints[0]?.definition).toContain("creator_fee_claim");
  await expect(pool.query("UPDATE agent_activity SET kind = 'swap' WHERE event_role = 'creator_fee_claim'")).rejects.toMatchObject({ code: "23514" });
}

describe("Lighter upgrades across merged migration histories", () => {
  it("upgrades the older Lighter-only lineage before its dependent forward repairs", async () => {
    await withDatabase(async (pool, staging) => {
      const lighterFiles = ALL_FILES.filter((file) => Number.parseInt(file, 10) <= 108
        && (Number.parseInt(file, 10) < 79 || !MAIN_FILES.includes(file)));
      copyMigrations(lighterFiles, staging);
      await runMigrationsWithProgress({ pool, migrationsDir: staging });
      await pool.query("DROP TABLE schema_migration_files, schema_migration_baseline");
      await pool.query(`INSERT INTO lighter_nonce_state
        (environment, account_index, api_key_index, provider_nonce, public_key, status, reserved_nonce, reservation_id)
        VALUES ('core', 42, 7, '3', 'public-key-fixture', 'ambiguous', '4', 'retained-reservation')`);
      const before = (await pool.query("SELECT * FROM lighter_nonce_state")).rows;
      copyMigrations(ALL_FILES, staging);
      await runMigrationsWithProgress({ pool, migrationsDir: staging });
      expect((await pool.query("SELECT * FROM lighter_nonce_state")).rows).toEqual(before);
      await seedMainRecords(pool);
      await assertCompleted(pool, staging);
    });
  }, 120_000);

  for (const legacy of [true, false]) {
    it(`upgrades populated main with ${legacy ? "numeric-only" : "filename"} history without losing audit records`, async () => {
      await withDatabase(async (pool, staging) => {
        copyMigrations(MAIN_FILES, staging);
        await runMigrationsWithProgress({ pool, migrationsDir: staging });
        if (legacy) await pool.query("DROP TABLE schema_migration_files, schema_migration_baseline");
        await seedMainRecords(pool);
        const before = await retainedRecords(pool);
        copyMigrations(ALL_FILES, staging);
        const result = await runMigrationsWithProgress({ pool, migrationsDir: staging });
        expect(result.files).toContain("086_lighter_onboarding_intents.sql");
        expect(result.files).toContain("105_lighter_rhc_withdrawals.sql");
        expect(await retainedRecords(pool)).toEqual(before);
        await assertCompleted(pool, staging);
      });
    }, 120_000);
  }

  it("resumes every planned migration after a crash following the first recovered table", async () => {
    await withDatabase(async (pool, staging) => {
      copyMigrations(MAIN_FILES, staging);
      await runMigrationsWithProgress({ pool, migrationsDir: staging });
      await pool.query("DROP TABLE schema_migration_files, schema_migration_baseline");
      await seedMainRecords(pool);
      const before = await retainedRecords(pool);
      copyMigrations(ALL_FILES, staging);
      await expect(runMigrationsWithProgress({ pool, migrationsDir: staging, onProgress(event) {
        if (event.phase === "applied" && event.file === "086_lighter_onboarding_intents.sql") throw new Error("interrupted upgrade");
      } })).rejects.toThrow("interrupted upgrade");
      const pending = (await pool.query<{ file: string }>("SELECT file FROM schema_migration_recovery_files")).rows.map(({ file }) => file);
      expect(pending).toContain("087_lighter_allowance_verified.sql");
      expect(pending).toContain("101_lighter_rhc_funding_preflight.sql");
      await runMigrationsWithProgress({ pool, migrationsDir: staging });
      expect(await retainedRecords(pool)).toEqual(before);
      await assertCompleted(pool, staging);
    });
  }, 120_000);

  it("preserves existing Lighter nonce reservations and newer constraints with legacy tracking", async () => {
    await withDatabase(async (pool, staging) => {
      copyMigrations(ALL_FILES.filter((file) => Number.parseInt(file, 10) <= 119), staging);
      await runMigrationsWithProgress({ pool, migrationsDir: staging });
      await seedMainRecords(pool);
      await pool.query(`INSERT INTO lighter_nonce_state
        (environment, account_index, api_key_index, provider_nonce, public_key, status, reserved_nonce, reservation_id)
        VALUES ('rhc', 42, 7, '3', 'public-key-fixture', 'ambiguous', '4', 'retained-reservation')`);
      const before = await retainedRecords(pool);
      const nonceBefore = (await pool.query("SELECT * FROM lighter_nonce_state")).rows;
      await pool.query("DROP TABLE schema_migration_files, schema_migration_baseline");
      copyMigrations(ALL_FILES, staging);
      const result = await runMigrationsWithProgress({ pool, migrationsDir: staging });
      expect(result.files).toEqual(["120_merged_activity_constraints.sql"]);
      expect(await retainedRecords(pool)).toEqual(before);
      expect((await pool.query("SELECT * FROM lighter_nonce_state")).rows).toEqual(nonceBefore);
      await assertCompleted(pool, staging);
    });
  }, 120_000);
});
