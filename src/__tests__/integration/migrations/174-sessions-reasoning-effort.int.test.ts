/**
 * Integration: migration 174 applies ON TOP OF a schema that stands at 173
 * with existing session rows, keeps those rows intact (NULL effort = never
 * picked), is idempotent, refuses an unknown effort, and the engine repo
 * round-trips a pick through the real column.
 *
 * Mechanism (same as the 096/101 templates): a second, disposable database
 * inside the suite's testcontainer, the real `runMigrationsWithProgress`
 * pointed at a staging directory holding only the files at or below 173, then
 * 174 copied in and the runner invoked again. Nothing is stubbed.
 */

import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pg from "pg";

import { runMigrationsWithProgress } from "../../../lib/db/migrate-runner.js";
import { getVexAgentMigrationsDir } from "@utils/package-assets.js";

const SOURCE_DIR = getVexAgentMigrationsDir();
const TARGET_DB = "vex_174_probe";
const MIGRATION_174 = "174_sessions_reasoning_effort.sql";

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

async function hasColumn(): Promise<boolean> {
  const res = await pool.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM information_schema.columns
      WHERE table_name = 'sessions' AND column_name = 'reasoning_effort'`,
  );
  return Number(res.rows[0]?.n ?? "0") > 0;
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
  stagingDir = mkdtempSync(path.join(tmpdir(), "vex-174-"));
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

describe("migration 174 on a schema that stands at 173", () => {
  it("reaches 173 with no reasoning_effort column, and seeds existing sessions", async () => {
    const upTo173 = filesUpTo(173);
    for (const f of upTo173) copyFileSync(path.join(SOURCE_DIR, f), path.join(stagingDir, f));
    const result = await runMigrationsWithProgress({ pool, migrationsDir: stagingDir });
    expect(result.applied).toBe(upTo173.length);
    expect(await schemaVersion()).toBe(173);
    expect(await hasColumn()).toBe(false);

    await pool.query(
      `INSERT INTO sessions (id, mode, permission) VALUES
         ('s-agent', 'agent', 'full'),
         ('s-mission', 'mission', 'restricted')`,
    );
  }, 180_000);

  it("applies 174 as the next increment, keeps existing rows, and re-running is a no-op", async () => {
    copyFileSync(path.join(SOURCE_DIR, MIGRATION_174), path.join(stagingDir, MIGRATION_174));
    const first = await runMigrationsWithProgress({ pool, migrationsDir: stagingDir });
    expect(first.applied).toBe(1);
    expect(first.files).toEqual([MIGRATION_174]);
    expect(await schemaVersion()).toBe(174);
    expect(await hasColumn()).toBe(true);

    const rows = await pool.query<{ id: string; mode: string; reasoning_effort: string | null }>(
      "SELECT id, mode, reasoning_effort FROM sessions ORDER BY id",
    );
    expect(rows.rows).toEqual([
      { id: "s-agent", mode: "agent", reasoning_effort: null },
      { id: "s-mission", mode: "mission", reasoning_effort: null },
    ]);

    const second = await runMigrationsWithProgress({ pool, migrationsDir: stagingDir });
    expect(second.applied).toBe(0);
    const sql = readFileSync(path.join(SOURCE_DIR, MIGRATION_174), "utf-8");
    await expect(pool.query(sql)).resolves.toBeDefined();
  }, 180_000);

  it("stores every known effort and refuses an unknown one", async () => {
    for (const effort of ["none", "minimal", "low", "medium", "high", "xhigh", "max"]) {
      await pool.query("UPDATE sessions SET reasoning_effort = $1 WHERE id = 's-agent'", [effort]);
    }
    await expect(
      pool.query("UPDATE sessions SET reasoning_effort = 'turbo' WHERE id = 's-agent'"),
    ).rejects.toThrow(/check constraint/);
  });

  it("round-trips a pick through the engine repo against the real column", async () => {
    const previous = process.env.VEX_DB_URL;
    const url = new URL(previous ?? "");
    url.pathname = `/${TARGET_DB}`;
    process.env.VEX_DB_URL = url.toString();
    try {
      const { closePool } = await import("@vex-agent/db/client.js");
      await closePool();
      const repo = await import("@vex-agent/db/repos/session-reasoning-effort.js");
      await repo.setSessionReasoningEffort("s-agent", "low");
      expect(await repo.getSessionReasoningEffort("s-agent")).toBe("low");
      expect(await repo.getSessionReasoningEffort("s-mission")).toBeNull();
      expect(await repo.getSessionReasoningEffort("missing")).toBeNull();
      await closePool();
    } finally {
      process.env.VEX_DB_URL = previous;
    }
  });
});
