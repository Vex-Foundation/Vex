/**
 * Integration: migration 094 applies cleanly to a schema that stops at 084.
 *
 * WHY THIS EXISTS. `globalSetup` runs the whole chain 001..094 in one pass on an
 * empty database, which proves the file is valid SQL and nothing more. It does
 * NOT prove the thing that actually matters for a migration landing on real
 * installations:
 *
 *   1. the columns/CHECKs/index do not already exist at 084 (a rename or a
 *      collision with the concurrent 085/086 studio branch would show up here);
 *   2. the new CHECKs admit the rows that are ALREADY in the table. Migration 082
 *      shipped a pair of mutually-unsatisfiable constraints found only by
 *      applying the DDL to a populated Postgres - a green unit suite cannot see
 *      a defect that lives in DDL;
 *   3. the version gap (085/086 unclaimed here) does not stop the runner.
 *
 * MECHANISM. A second database is created inside the SAME container the suite
 * already runs, and the real `runMigrationsWithProgress` is pointed at a temp
 * directory holding only the files at or below 084. Rows are inserted at that
 * schema. Then 094 is copied in and the runner is invoked again, so 094 applies
 * as an INCREMENT to a populated 084 schema rather than as step 87 of a fresh
 * chain. Nothing is stubbed: same runner, same files, same Postgres.
 */

import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pg from "pg";

import { runMigrationsWithProgress } from "../../../lib/db/migrate-runner.js";
import { getVexAgentMigrationsDir } from "@utils/package-assets.js";

const SOURCE_DIR = getVexAgentMigrationsDir();
const TARGET_DB = "vex_094_probe";
const MIGRATION_094 = "094_pools_launch_attribution.sql";

let pool: pg.Pool;
let stagingDir: string;

/** Migration filenames at or below `maxVersion`, in application order. */
function filesUpTo(maxVersion: number): string[] {
  return readdirSync(SOURCE_DIR)
    .filter((f) => f.endsWith(".sql") && /^\d{3}_/.test(f))
    .filter((f) => parseInt(f.slice(0, 3), 10) <= maxVersion)
    .sort();
}

function stage(files: readonly string[]): void {
  for (const f of files) copyFileSync(path.join(SOURCE_DIR, f), path.join(stagingDir, f));
}

async function columnNames(): Promise<string[]> {
  const res = await pool.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'launched_tokens'`,
  );
  return res.rows.map((r) => r.column_name);
}

async function constraintNames(): Promise<string[]> {
  const res = await pool.query<{ conname: string }>(
    `SELECT conname FROM pg_constraint WHERE conrelid = 'launched_tokens'::regclass AND contype = 'c'`,
  );
  return res.rows.map((r) => r.conname);
}

/**
 * The single row a one-row probe query must have returned.
 *
 * A throwing accessor rather than a non-null assertion: "the catalog query
 * matched nothing" is itself a meaningful failure for these tests, and it should
 * be named rather than surface as a property access on undefined.
 */
function onlyRow<T extends pg.QueryResultRow>(result: pg.QueryResult<T>, what: string): T {
  const row = result.rows[0];
  if (row === undefined) throw new Error(`expected exactly one row for ${what}, got none`);
  return row;
}

beforeAll(async () => {
  const base = process.env.VEX_DB_URL;
  if (!base) throw new Error("VEX_DB_URL is unset - globalSetup did not run.");

  const admin = new pg.Pool({ connectionString: base });
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${TARGET_DB}`);
    await admin.query(`CREATE DATABASE ${TARGET_DB}`);
  } finally {
    await admin.end();
  }

  const url = new URL(base);
  url.pathname = `/${TARGET_DB}`;
  pool = new pg.Pool({ connectionString: url.toString() });

  stagingDir = mkdtempSync(path.join(tmpdir(), "vex-094-"));
}, 120_000);

afterAll(async () => {
  await pool?.end();
  if (stagingDir) rmSync(stagingDir, { recursive: true, force: true });
  const base = process.env.VEX_DB_URL;
  if (base) {
    const admin = new pg.Pool({ connectionString: base });
    try {
      await admin.query(`DROP DATABASE IF EXISTS ${TARGET_DB}`);
    } finally {
      await admin.end();
    }
  }
});

describe("094 applies to a populated schema at 084", () => {
  it("reaches 084 with none of 094's objects present", async () => {
    stage(filesUpTo(84));
    const result = await runMigrationsWithProgress({ pool, migrationsDir: stagingDir });
    expect(result.applied).toBe(filesUpTo(84).length);

    const version = await pool.query<{ v: number }>(
      `SELECT COALESCE(MAX(version), 0)::int AS v FROM schema_version`,
    );
    expect(onlyRow(version, "schema_version high-water mark").v).toBe(84);

    // Nothing 094 adds may pre-exist, or the migration is redefining someone
    // else's object rather than adding its own.
    const columns = await columnNames();
    for (const c of [
      "pools_attest_signature",
      "pools_attribution_attempted_at",
      "pools_attributed_at",
      "pools_attribution_rejected_at",
      "pools_attribution_rejection_code",
    ]) {
      expect(columns).not.toContain(c);
    }
  });

  it("094 applies over EXISTING rows and leaves them valid", async () => {
    // A trench row and a pools row, written at the 084 schema - exactly what a
    // real installation holds when 094 arrives. If any new CHECK were written so
    // that all-NULL failed it, this ALTER would abort here.
    for (const launchpad of ["trench_express", "pools_fun"]) {
      await pool.query(
        `INSERT INTO launched_tokens
           (wallet_address, chain_id, launchpad, token_address, name, symbol, create_tx_hash)
         VALUES ($1, 4663, $2, $3, 'Pre 094', 'PRE', $4)`,
        [`0x${"1".repeat(40)}`, launchpad, `0x${launchpad === "pools_fun" ? "2" : "3"}${"0".repeat(39)}`, `0x${"4".repeat(64)}`],
      );
    }

    copyFileSync(path.join(SOURCE_DIR, MIGRATION_094), path.join(stagingDir, MIGRATION_094));
    const result = await runMigrationsWithProgress({ pool, migrationsDir: stagingDir });

    // Exactly one file applied, and the 085/086 gap did not stop the runner.
    expect(result.applied).toBe(1);
    expect(result.files).toEqual([MIGRATION_094]);

    const rows = await pool.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM launched_tokens`);
    expect(Number(onlyRow(rows, "launched_tokens row count").n)).toBe(2);
  });

  it("adds the five columns, the four CHECKs and the partial index", async () => {
    const columns = await columnNames();
    expect(columns).toEqual(
      expect.arrayContaining([
        "pools_attest_signature",
        "pools_attribution_attempted_at",
        "pools_attributed_at",
        "pools_attribution_rejected_at",
        "pools_attribution_rejection_code",
      ]),
    );

    expect(await constraintNames()).toEqual(
      expect.arrayContaining([
        "launched_tokens_pools_rejection_has_code",
        "launched_tokens_pools_one_terminal_state",
        "launched_tokens_pools_rejection_code_valid",
        "launched_tokens_pools_terminal_requires_signature",
      ]),
    );

    const index = await pool.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes
        WHERE tablename = 'launched_tokens'
          AND indexname = 'idx_launched_tokens_pending_pools_attribution'`,
    );
    expect(index.rowCount).toBe(1);
    const def = onlyRow(index, "the pools attribution partial index").indexdef;
    // The launchpad belongs IN the partial predicate: chain 4663 carries both
    // venues, so an index without it would cover the wrong population.
    expect(def).toContain("launchpad = 'pools_fun'");
    expect(def).toContain("pools_attest_signature IS NOT NULL");
    expect(def).toContain("pools_attributed_at IS NULL");
    expect(def).toContain("pools_attribution_rejected_at IS NULL");
  });

  it("the rejection-code CHECK carries EXACTLY the three frozen literals", async () => {
    // The vocabulary is mirrored by `src/tools/pools-fun/attribution-codes.ts`,
    // which has its own lockstep test against this constraint. Pinning the set
    // here as well means a widening cannot land as a one-sided edit.
    const res = await pool.query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conrelid = 'launched_tokens'::regclass
          AND conname = 'launched_tokens_pools_rejection_code_valid'`,
    );
    const def = onlyRow(res, "the rejection-code CHECK").def;
    const literals = [...def.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
    expect(literals).toEqual(["invalid_signature", "not_pools_launch", "validation_failed"]);
  });

  it("re-running the chain is a no-op - 094 is not re-applied", async () => {
    const result = await runMigrationsWithProgress({ pool, migrationsDir: stagingDir });
    expect(result.applied).toBe(0);
  });
});
