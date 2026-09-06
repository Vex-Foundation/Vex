/**
 * Integration: migration 111 advances the AgentScan coverage version, applied as
 * an INCREMENT on a populated schema at 110.
 *
 * WHY THIS EXISTS. `globalSetup` runs 001..111 on an EMPTY database, which
 * proves the file is valid SQL and nothing else. This migration's entire risk is
 * what it does to an installation whose reporting state is ALREADY POPULATED -
 * specifically the one the defect is about: a main installation that completed
 * the V2 backfill, carries the mark that says so, and would otherwise report its
 * whole historical launch-fee population to AgentScan as live activity.
 *
 * The posture is the one `agents-colab/vscode`'s own one-time-migration test
 * uses (`workbench/services/extensions/test/browser/extensionStorageMigration.test.ts`):
 * assert BOTH halves. Not only "the version moved", but "every other column of
 * the marker stayed exactly where it was" - the timestamp that records when the
 * last backfill ran, the coverage stamp that says what it covered, the
 * registration generation, and every outbox row.
 *
 * MECHANISM (cloned from `108-trench-express-retirement.int.test.ts`): a second
 * database inside the SAME container the suite already runs, the real
 * `runMigrationsWithProgress` pointed at a temp directory holding only the files
 * at or below 110, rows inserted at that schema, then 111 copied in and the
 * runner invoked again. Nothing is stubbed.
 */

import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pg from "pg";

import { runMigrationsWithProgress } from "../../../lib/db/migrate-runner.js";
import { getVexAgentMigrationsDir } from "@utils/package-assets.js";

const SOURCE_DIR = getVexAgentMigrationsDir();
const TARGET_DB = "vex_111_probe";
const MIGRATION_111 = "111_agentscan_pools_fee_coverage.sql";

let pool: pg.Pool;
let stagingDir: string;

function filesUpTo(maxVersion: number): string[] {
  return readdirSync(SOURCE_DIR)
    .filter((f) => f.endsWith(".sql") && /^\d{3}_/.test(f))
    .filter((f) => parseInt(f.slice(0, 3), 10) <= maxVersion)
    .sort();
}

/**
 * The single row a one-row probe query must have returned. A throwing accessor
 * rather than a non-null assertion: "the probe matched nothing" is itself a
 * meaningful failure here and deserves a name.
 */
function onlyRow<T extends pg.QueryResultRow>(result: pg.QueryResult<T>, what: string): T {
  const row = result.rows[0];
  if (row === undefined) throw new Error(`expected exactly one row for ${what}, got none`);
  return row;
}

interface MarkerState {
  readonly vocabularyVersion: number;
  readonly backfillVocabularyVersion: number | null;
  readonly backfillEnqueuedAt: string | null;
  readonly registrationGeneration: number;
}

async function marker(): Promise<MarkerState> {
  const res = await pool.query<{
    vocabulary_version: number;
    backfill_vocabulary_version: number | null;
    backfill_enqueued_at: Date | null;
    registration_generation: number;
  }>(
    `SELECT vocabulary_version, backfill_vocabulary_version,
            backfill_enqueued_at, registration_generation
       FROM agentscan_reporting_state WHERE id = 1`,
  );
  const row = onlyRow(res, "the reporting-state singleton");
  return {
    vocabularyVersion: Number(row.vocabulary_version),
    backfillVocabularyVersion:
      row.backfill_vocabulary_version === null ? null : Number(row.backfill_vocabulary_version),
    backfillEnqueuedAt: row.backfill_enqueued_at === null ? null : row.backfill_enqueued_at.toISOString(),
    registrationGeneration: Number(row.registration_generation),
  };
}

async function applyThrough(maxVersion: number): Promise<void> {
  for (const f of filesUpTo(maxVersion)) {
    copyFileSync(path.join(SOURCE_DIR, f), path.join(stagingDir, f));
  }
  await runMigrationsWithProgress({ pool, migrationsDir: stagingDir });
}

async function apply111(): Promise<void> {
  copyFileSync(path.join(SOURCE_DIR, MIGRATION_111), path.join(stagingDir, MIGRATION_111));
  await runMigrationsWithProgress({ pool, migrationsDir: stagingDir });
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

  stagingDir = mkdtempSync(path.join(tmpdir(), "vex-111-"));
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

describe("111 advances AgentScan coverage over a populated schema at 110", () => {
  it("reaches 110 and seeds the installation that completed the V2 backfill", async () => {
    await applyThrough(110);

    // The singleton is created LAZILY by the repo, never by a migration, so an
    // upgrading installation is one that already has it. This is exactly the
    // state a main install carries: widened schema, backfill run, mark at 2.
    await pool.query(
      `INSERT INTO agentscan_reporting_state (id, vocabulary_version, backfill_enqueued_at,
                                              backfill_vocabulary_version, registration_generation)
       VALUES (1, 2, NOW() - interval '3 days', 2, 4)`,
    );

    const before = await marker();
    expect(before.vocabularyVersion).toBe(2);
    expect(before.backfillVocabularyVersion).toBe(2);
    expect(before.backfillEnqueuedAt).not.toBeNull();
  });

  it("walks the version to 3 and moves NOTHING else on that installation", async () => {
    const before = await marker();

    await apply111();

    const after = await marker();
    expect(after.vocabularyVersion).toBe(3);
    // The three facts 111 must not touch. The coverage stamp still says 2, which
    // is what makes `backfillOwed` true and routes the historical launch-fee
    // rows through the CONTROLLED backfill instead of an incremental tick.
    expect(after.backfillVocabularyVersion).toBe(2);
    expect(after.backfillEnqueuedAt).toBe(before.backfillEnqueuedAt);
    expect(after.registrationGeneration).toBe(before.registrationGeneration);
  });

  it("re-applying the file is a no-op on an installation already at 3", async () => {
    await pool.query(
      `UPDATE agentscan_reporting_state
          SET backfill_vocabulary_version = 3, updated_at = NOW() WHERE id = 1`,
    );
    const before = await marker();

    // The runner will not re-offer an applied version, so the idempotency of the
    // FILE is proven by executing it directly - the property a hand repair or a
    // re-run of the mirror depends on.
    const { readFileSync } = await import("node:fs");
    await pool.query(readFileSync(path.join(SOURCE_DIR, MIGRATION_111), "utf-8"));

    expect(await marker()).toEqual(before);
  });

  it("a singleton created after 111 is born at 3, so a fresh install needs no walk", async () => {
    await pool.query(`DELETE FROM agentscan_reporting_state WHERE id = 1`);
    await pool.query(`INSERT INTO agentscan_reporting_state (id) VALUES (1)`);

    const fresh = await marker();
    expect(fresh.vocabularyVersion).toBe(3);
    // Nothing has been backfilled, so the first backfill covers all three
    // vocabularies at once.
    expect(fresh.backfillVocabularyVersion).toBeNull();
    expect(fresh.backfillEnqueuedAt).toBeNull();
  });

  it("touches no outbox row: what gets re-queued is the diff scan's decision, not this file's", async () => {
    const outbox = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM agentscan_outbox`,
    );
    expect(onlyRow(outbox, "the outbox count").count).toBe("0");
  });
});
