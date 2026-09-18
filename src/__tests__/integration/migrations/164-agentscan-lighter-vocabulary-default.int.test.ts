/**
 * Integration: migration 164 fixes the `agentscan_reporting_state.vocabulary_version`
 * column DEFAULT, which 152 left at 3 while bumping LIGHTER_VOCABULARY_VERSION to 4.
 *
 * WHY THIS EXISTS. 152 walks an EXISTING row forward with
 * `UPDATE ... WHERE id = 1 AND vocabulary_version < 4`, which is a no-op when no row
 * exists yet. `ensureSingleton()` never sets `vocabulary_version` itself - it relies on
 * the column DEFAULT - so any install that registers with AgentScan after 152 has
 * already run inherits whatever the default still says. 152 never touched the
 * default, so it stayed at 3: forever below the gate `enqueueEligibleLighterFills`
 * and the exchange-funding V4 arm both check, so no Lighter fill or funding leg was
 * ever enqueued to `agentscan_outbox` for such an install. Not held with a reason -
 * the outbox row was simply never created.
 *
 * 111 has exactly this test for its own version ("a singleton created after 111 is
 * born at 3, so a fresh install needs no walk") because 3 was correct at that point
 * in the migration history. The same shape of test was never written for 152, which
 * is how this shipped. Same mechanism as that test and 108's: a second database
 * inside the same container, `runMigrationsWithProgress` pointed at a staged
 * directory, nothing stubbed.
 */

import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pg from "pg";

import { runMigrationsWithProgress } from "../../../lib/db/migrate-runner.js";
import { getVexAgentMigrationsDir } from "@utils/package-assets.js";

const SOURCE_DIR = getVexAgentMigrationsDir();
const TARGET_DB = "vex_164_probe";
const MIGRATION_164 = "164_agentscan_lighter_vocabulary_default.sql";

let pool: pg.Pool;
let stagingDir: string;

function filesUpTo(maxVersion: number): string[] {
  return readdirSync(SOURCE_DIR)
    .filter((f) => f.endsWith(".sql") && /^\d{3}_/.test(f))
    .filter((f) => parseInt(f.slice(0, 3), 10) <= maxVersion)
    .sort();
}

async function applyThrough(maxVersion: number): Promise<void> {
  for (const f of filesUpTo(maxVersion)) {
    copyFileSync(path.join(SOURCE_DIR, f), path.join(stagingDir, f));
  }
  await runMigrationsWithProgress({ pool, migrationsDir: stagingDir });
}

async function apply164(): Promise<void> {
  copyFileSync(path.join(SOURCE_DIR, MIGRATION_164), path.join(stagingDir, MIGRATION_164));
  await runMigrationsWithProgress({ pool, migrationsDir: stagingDir });
}

async function vocabularyVersion(): Promise<number> {
  const res = await pool.query<{ vocabulary_version: number }>(
    `SELECT vocabulary_version FROM agentscan_reporting_state WHERE id = 1`,
  );
  const row = res.rows[0];
  if (row === undefined) throw new Error("expected the reporting-state singleton, got none");
  return Number(row.vocabulary_version);
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
  await pool.query("CREATE EXTENSION IF NOT EXISTS vector");

  stagingDir = mkdtempSync(path.join(tmpdir(), "vex-164-"));
}, 180_000);

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

describe("164 fixes the vocabulary_version default that 152 left behind", () => {
  it("reproduces the defect: a singleton born after 152 is still stuck at 3", async () => {
    await applyThrough(152);
    await pool.query(`INSERT INTO agentscan_reporting_state (id) VALUES (1)`);
    expect(await vocabularyVersion()).toBe(3);
  });

  it("164 walks that same installation forward to 4", async () => {
    await apply164();
    expect(await vocabularyVersion()).toBe(4);
  });

  it("after 164, a brand-new singleton is born at 4 - the default itself is fixed", async () => {
    await pool.query(`DELETE FROM agentscan_reporting_state WHERE id = 1`);
    await pool.query(`INSERT INTO agentscan_reporting_state (id) VALUES (1)`);
    expect(await vocabularyVersion()).toBe(4);
  });
});
