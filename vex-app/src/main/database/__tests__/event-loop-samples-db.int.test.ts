/**
 * K-5 on a real Postgres (the studio-postgres lane's testcontainer): migration
 * 175's table takes the writer's row, refuses impossible values, and the
 * `kairos-runtime:report` section 8 queries read it back.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

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
import { buildReportQueries, runReportQueries } from "@vex-agent/scripts/kairos-runtime-report.js";
import {
  eventLoopWriteStats,
  recordEventLoopWindow,
  resetEventLoopWriteStateForTests,
} from "../event-loop-samples-db.js";

const WINDOW = {
  windowMs: 60_000,
  sampleCount: 2_900,
  p50Ms: 10.5,
  p99Ms: 48.25,
  maxMs: 410,
  stallCount: 2,
  stallThresholdMs: 100,
  longestStallMs: 390.5,
};

beforeEach(async () => {
  resetEventLoopWriteStateForTests();
  await execute("DELETE FROM main_event_loop_samples");
});

describe("main_event_loop_samples (migration 175)", () => {
  it("stores the writer's window and the report reads it back", async () => {
    recordEventLoopWindow(WINDOW);
    await vi.waitFor(async () => {
      const rows = await query<{ n: string }>("SELECT count(*)::text AS n FROM main_event_loop_samples");
      expect(rows[0]?.n).toBe("1");
    });
    expect(eventLoopWriteStats().inFlight).toBe(0);

    const since = new Date(Date.now() - 3_600_000);
    const section8 = buildReportQueries(since).filter((q) => q.section === 8);
    const results = await runReportQueries(section8, (sql, params) =>
      query<Record<string, unknown>>(sql, [...params]),
    );
    expect(results.map((r) => r.status)).toEqual(["ok", "ok"]);
    const summary = results[0]?.rows[0];
    expect(Number(summary?.windows)).toBe(1);
    expect(Number(summary?.stalls)).toBe(2);
    expect(Number(summary?.max_ms)).toBe(410);
  });

  it("refuses negative numbers and a zero stall threshold", async () => {
    await expect(
      execute(
        `INSERT INTO main_event_loop_samples
           (window_ms, sample_count, p50_ms, p99_ms, max_ms, stall_count, stall_threshold_ms, longest_stall_ms)
         VALUES (60000, 1, -1, 1, 1, 0, 100, 0)`,
      ),
    ).rejects.toThrow();
    await expect(
      execute(
        `INSERT INTO main_event_loop_samples
           (window_ms, sample_count, p50_ms, p99_ms, max_ms, stall_count, stall_threshold_ms, longest_stall_ms)
         VALUES (60000, 1, 1, 1, 1, 0, 0, 0)`,
      ),
    ).rejects.toThrow();
  });
});
