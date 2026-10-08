/**
 * K-4 on a real Postgres (the studio-postgres lane's testcontainer, never the
 * owner's database): parity of the shared main-process pool with today's
 * fresh-client-per-call `withClient`, its transaction hygiene and bound, and
 * the per-call latency both paths pay.
 *
 * The benchmark prints its numbers (`[k4-bench]`) and asserts only that the
 * pooled path is not slower than the per-call one, so a loaded CI host cannot
 * turn a measurement into a flaky gate.
 */

import { performance } from "node:perf_hooks";

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../logger/index.js", () => ({
  log: {
    debug: (): void => undefined,
    info: (): void => undefined,
    warn: (): void => undefined,
    error: (): void => undefined,
  },
}));

vi.mock("../db-config.js", () => ({
  buildPoolConfig: () => {
    const value = process.env.VEX_DB_URL;
    if (value === undefined || value === "") return Promise.resolve(null);
    const url = new URL(value);
    return Promise.resolve({
      host: url.hostname,
      port: Number(url.port),
      database: url.pathname.replace(/^\//, ""),
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
    });
  },
}));

import { execute, query } from "@vex-agent/db/client.js";
import { ok } from "@shared/ipc/result.js";
import {
  MAIN_IPC_PG_POOL_MAX,
  closeMainIpcPgPool,
  setMainIpcPgPoolOverrideForTests,
} from "../main-ipc-pg-pool.js";
import { withClient } from "../sessions/connection.js";
import { createSession } from "../sessions/create.js";
import { getSessionById, listSessions } from "../sessions/read.js";
import { renameSession } from "../sessions/rename.js";

async function resetDb(): Promise<void> {
  const rows = await query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables
      WHERE schemaname = 'public'
        AND tablename NOT IN ('schema_version', 'lighter_schema_marker')`,
  );
  if (rows.length === 0) return;
  const tables = rows.map(({ tablename }) => `"${tablename}"`).join(", ");
  await execute(`TRUNCATE TABLE ${tables} RESTART IDENTITY CASCADE`);
}

async function backendPid(): Promise<number> {
  const result = await withClient(async (client) => {
    const r = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
    return ok(r.rows[0]?.pid ?? -1);
  });
  if (!result.ok) throw new Error("backendPid failed");
  return result.data;
}

/** Sessions the test can see, minus timestamps that differ between runs. */
async function sessionSnapshot(): Promise<unknown> {
  const result = await listSessions();
  if (!result.ok) throw new Error("listSessions failed");
  return result.data.map((item) => ({ ...item }));
}

beforeEach(resetDb);

afterEach(async () => {
  await closeMainIpcPgPool();
  setMainIpcPgPoolOverrideForTests(null);
});

afterAll(async () => {
  await closeMainIpcPgPool();
});

describe("K-4 parity: the same IPC reads and writes, pooled or per call", () => {
  it("returns identical results for create, rename, get and list in both modes", async () => {
    const outcomes: Record<string, unknown[]> = { off: [], on: [] };
    for (const mode of ["off", "on"] as const) {
      setMainIpcPgPoolOverrideForTests(mode === "on");
      const created = await createSession({
        mode: "agent",
        name: `k4 ${mode}`,
        permission: "restricted",
      });
      if (!created.ok) throw new Error("createSession failed");
      const id = created.data.id;
      const renamed = await renameSession(id, `k4 ${mode} renamed`);
      const fetched = await getSessionById(id);
      const missing = await getSessionById("00000000-0000-4000-8000-00000000dead");
      const bucket = outcomes[mode];
      if (bucket === undefined) throw new Error("missing bucket");
      bucket.push(
        renamed.ok,
        fetched.ok ? fetched.data?.title : "error",
        missing.ok ? missing.data : "error",
      );
      await closeMainIpcPgPool();
    }
    expect(outcomes.on).toEqual([true, "k4 on renamed", null]);
    expect(outcomes.off).toEqual([true, "k4 off renamed", null]);

    setMainIpcPgPoolOverrideForTests(false);
    const listedOff = await sessionSnapshot();
    setMainIpcPgPoolOverrideForTests(true);
    const listedOn = await sessionSnapshot();
    expect(listedOn).toEqual(listedOff);
  });
});

describe("K-4 transaction hygiene on the pool", () => {
  beforeEach(() => {
    setMainIpcPgPoolOverrideForTests(true);
  });

  it("keeps one backend for a whole transaction", async () => {
    const result = await withClient(async (client) => {
      const pids: number[] = [];
      await client.query("BEGIN");
      for (let i = 0; i < 3; i += 1) {
        const r = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
        pids.push(r.rows[0]?.pid ?? -1);
      }
      await client.query("COMMIT");
      return ok(pids);
    });
    if (!result.ok) throw new Error("transaction failed");
    expect(new Set(result.data).size).toBe(1);
  });

  it("never hands an open transaction to the next caller: the write is rolled back", async () => {
    const leftOpen = await withClient(async (client) => {
      await client.query("BEGIN");
      await client.query(
        "INSERT INTO sessions (id, scope, mode, permission, title) VALUES ($1, 'vex_app', 'agent', 'restricted', 'left open')",
        ["00000000-0000-4000-8000-0000000000a1"],
      );
      return ok("returned without COMMIT");
    });
    expect(leftOpen.ok).toBe(true);
    const next = await withClient(async (client) => {
      const r = await client.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM sessions WHERE title = 'left open'",
      );
      const tx = await client.query<{ open: boolean }>(
        "SELECT now() <> statement_timestamp() AS open",
      );
      return ok({ n: r.rows[0]?.n, open: tx.rows[0]?.open });
    });
    if (!next.ok) throw new Error("next caller failed");
    expect(next.data).toEqual({ n: "0", open: false });
    const idleInTx = await query<{ n: string }>(
      "SELECT count(*)::text AS n FROM pg_stat_activity WHERE state LIKE 'idle in transaction%' AND pid <> pg_backend_pid()",
    );
    expect(idleInTx[0]?.n).toBe("0");
  });

  it("releases the client when the callback throws, and the pool keeps serving", async () => {
    await expect(
      withClient(async (client) => {
        await client.query("BEGIN");
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await backendPid()).toBeGreaterThan(0);
  });

  it("bounds a burst to MAIN_IPC_PG_POOL_MAX connections and answers every call", async () => {
    const pids = await Promise.all(
      Array.from({ length: 16 }, () =>
        withClient(async (client) => {
          const r = await client.query<{ pid: number }>(
            "SELECT pg_backend_pid() AS pid, pg_sleep(0.02)",
          );
          return ok(r.rows[0]?.pid ?? -1);
        }),
      ),
    );
    expect(pids.every((r) => r.ok)).toBe(true);
    const distinct = new Set(pids.map((r) => (r.ok ? r.data : -1)));
    expect(distinct.size).toBeLessThanOrEqual(MAIN_IPC_PG_POOL_MAX);
  });

  it("recovers when the server terminates the pooled connections (a Postgres restart)", async () => {
    const before = await backendPid();
    await query("SELECT pg_terminate_backend($1)", [before]);
    // The idle client's socket error is observed asynchronously.
    await new Promise((resolve) => setTimeout(resolve, 100));
    const after = await backendPid();
    expect(after).toBeGreaterThan(0);
    expect(after).not.toBe(before);
  });
});

describe("K-4 benchmark: per-call connect vs pooled", () => {
  const RUNS = 60;

  async function timeCalls(pooled: boolean): Promise<number[]> {
    setMainIpcPgPoolOverrideForTests(pooled);
    await backendPid(); // warm-up (and the pool's first connect)
    const samples: number[] = [];
    for (let i = 0; i < RUNS; i += 1) {
      const start = performance.now();
      await backendPid();
      samples.push(performance.now() - start);
    }
    await closeMainIpcPgPool();
    return samples;
  }

  async function timeBurst(pooled: boolean, size: number): Promise<number> {
    setMainIpcPgPoolOverrideForTests(pooled);
    await backendPid();
    const start = performance.now();
    await Promise.all(Array.from({ length: size }, () => backendPid()));
    const elapsed = performance.now() - start;
    await closeMainIpcPgPool();
    return elapsed;
  }

  function pct(values: number[], p: number): number {
    const sorted = [...values].sort((a, b) => a - b);
    const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
    return Math.round((sorted[index] ?? 0) * 100) / 100;
  }

  it("measures sequential and burst latency in both modes", async () => {
    const perCall = await timeCalls(false);
    const pooled = await timeCalls(true);
    const burstPerCall = await timeBurst(false, 20);
    const burstPooled = await timeBurst(true, 20);
    const report = {
      runs: RUNS,
      perCallP50Ms: pct(perCall, 50),
      perCallP95Ms: pct(perCall, 95),
      pooledP50Ms: pct(pooled, 50),
      pooledP95Ms: pct(pooled, 95),
      burst20PerCallMs: Math.round(burstPerCall * 100) / 100,
      burst20PooledMs: Math.round(burstPooled * 100) / 100,
    };
    console.info(`[k4-bench] ${JSON.stringify(report)}`);
    expect(report.pooledP50Ms).toBeLessThanOrEqual(report.perCallP50Ms);
  });
});
