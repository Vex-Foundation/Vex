/**
 * Integration: migration 182 applies ON TOP OF a schema that stands at 181
 * with existing session rows, keeps those rows intact (no pick = default
 * model), is idempotent, refuses a half-written pick, and the engine repo
 * round-trips a pick through the real columns (F06).
 *
 * Mechanism (same as the 174 template): a second, disposable database inside
 * the suite's testcontainer, the real `runMigrationsWithProgress` pointed at
 * a staging directory holding only the files at or below 181, then 182
 * copied in and the runner invoked again. Nothing is stubbed.
 */

import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pg from "pg";

import { runMigrationsWithProgress } from "../../../lib/db/migrate-runner.js";
import { getVexAgentMigrationsDir } from "@utils/package-assets.js";

const SOURCE_DIR = getVexAgentMigrationsDir();
const TARGET_DB = "vex_182_probe";
const MIGRATION_182 = "182_sessions_model.sql";

let pool: pg.Pool;
let stagingDir: string;

function filesUpTo(maxVersion: number): string[] {
  return readdirSync(SOURCE_DIR)
    .filter((f) => f.endsWith(".sql") && /^\d{3}_/.test(f))
    .filter((f) => Number.parseInt(f.slice(0, 3), 10) <= maxVersion)
    .sort();
}

async function schemaVersion(): Promise<number> {
  const res = await pool.query<{ v: string }>(
    "SELECT COALESCE(MAX(version), 0)::text AS v FROM schema_version",
  );
  return Number(res.rows[0]?.v ?? "0");
}

async function modelColumns(): Promise<string[]> {
  const res = await pool.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
      WHERE table_name = 'sessions' AND column_name LIKE 'model\\_%'
      ORDER BY column_name`,
  );
  return res.rows.map((r) => r.column_name);
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
  stagingDir = mkdtempSync(path.join(tmpdir(), "vex-182-"));
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

describe("migration 182 on a schema that stands at 181", () => {
  it("reaches 181 with no model columns, and seeds existing sessions", async () => {
    const upTo181 = filesUpTo(181);
    for (const f of upTo181) copyFileSync(path.join(SOURCE_DIR, f), path.join(stagingDir, f));
    const result = await runMigrationsWithProgress({ pool, migrationsDir: stagingDir });
    expect(result.applied).toBe(upTo181.length);
    expect(await schemaVersion()).toBe(181);
    expect(await modelColumns()).toEqual([]);

    await pool.query(
      `INSERT INTO sessions (id, mode, permission) VALUES
         ('s-agent', 'agent', 'full'),
         ('s-mission', 'mission', 'restricted')`,
    );
  }, 180_000);

  it("applies 182 as the next increment, keeps existing rows, and re-running is a no-op", async () => {
    copyFileSync(path.join(SOURCE_DIR, MIGRATION_182), path.join(stagingDir, MIGRATION_182));
    const first = await runMigrationsWithProgress({ pool, migrationsDir: stagingDir });
    expect(first.applied).toBe(1);
    expect(first.files).toEqual([MIGRATION_182]);
    expect(await schemaVersion()).toBe(182);
    expect(await modelColumns()).toEqual(["model_id", "model_provider", "model_updated_at"]);

    const rows = await pool.query<{ id: string; model_provider: string | null; model_id: string | null }>(
      "SELECT id, model_provider, model_id FROM sessions ORDER BY id",
    );
    expect(rows.rows).toEqual([
      { id: "s-agent", model_provider: null, model_id: null },
      { id: "s-mission", model_provider: null, model_id: null },
    ]);

    const second = await runMigrationsWithProgress({ pool, migrationsDir: stagingDir });
    expect(second.applied).toBe(0);
    const sql = readFileSync(path.join(SOURCE_DIR, MIGRATION_182), "utf-8");
    await expect(pool.query(sql)).resolves.toBeDefined();
  }, 180_000);

  it("accepts a whole pick and refuses a half-written one", async () => {
    await pool.query(
      `UPDATE sessions SET model_provider = 'vexcloud', model_id = 'anthropic/claude-sonnet-5.5',
              model_updated_at = now() WHERE id = 's-agent'`,
    );
    await pool.query(
      "UPDATE sessions SET model_provider = NULL, model_id = NULL, model_updated_at = NULL WHERE id = 's-agent'",
    );
    await expect(
      pool.query("UPDATE sessions SET model_id = 'x/y', model_updated_at = now() WHERE id = 's-agent'"),
    ).rejects.toThrow(/sessions_model_pair_chk/);
    await expect(
      pool.query(
        "UPDATE sessions SET model_provider = 'openrouter', model_id = '', model_updated_at = now() WHERE id = 's-agent'",
      ),
    ).rejects.toThrow(/sessions_model_pair_chk/);
  });

  it("round-trips a pick through the engine repo against the real columns", async () => {
    const previous = process.env.VEX_DB_URL;
    const url = new URL(previous ?? "");
    url.pathname = `/${TARGET_DB}`;
    process.env.VEX_DB_URL = url.toString();
    try {
      const { closePool } = await import("@vex-agent/db/client.js");
      await closePool();
      const repo = await import("@vex-agent/db/repos/session-model.js");
      await repo.setSessionModel("s-agent", "openrouter", "openai/gpt-6-luna");
      const pick = await repo.getSessionModel("s-agent");
      expect(pick).toMatchObject({ provider: "openrouter", modelId: "openai/gpt-6-luna" });
      expect(Number.isNaN(Date.parse(pick?.updatedAt ?? ""))).toBe(false);
      expect(await repo.getSessionModel("s-mission")).toBeNull();
      expect(await repo.getSessionModel("missing")).toBeNull();

      // A backend this build does not know reads as no pick.
      await pool.query(
        "UPDATE sessions SET model_provider = 'future-backend', model_id = 'm/x', model_updated_at = now() WHERE id = 's-mission'",
      );
      expect(await repo.getSessionModel("s-mission")).toBeNull();
      await closePool();
    } finally {
      process.env.VEX_DB_URL = previous;
    }
  });
});
