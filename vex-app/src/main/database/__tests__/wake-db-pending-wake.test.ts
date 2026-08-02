/**
 * `getPendingWakeForSession` → the runtime DTO's `pausedWake`.
 *
 * Three properties, and the last two are the ones with teeth:
 *
 *  1. a pending row becomes `{ dueAt, reason, watchSummary }`;
 *  2. the raw `payload` JSONB NEVER crosses. It holds protocol-owned condition
 *     variants (thresholds, token ids, addresses) written by whichever
 *     protocol registered the watch evaluator. Only the condition TYPE names
 *     are summarised, so there is no path by which a variant field could
 *     become an accidental renderer contract;
 *  3. a DB failure DEGRADES to `null`, never to a thrown error. This read is a
 *     decoration on `runtime.getState`; a wake-table hiccup must not turn the
 *     whole runtime state — which gates the composer's pause/stop/resume —
 *     into an error result.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  connect: vi.fn(),
  end: vi.fn(),
  buildPoolConfig: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("pg", () => {
  function MockClient() {
    return { connect: mocks.connect, end: mocks.end, query: mocks.query };
  }
  return { Client: MockClient };
});
vi.mock("../db-config.js", () => ({ buildPoolConfig: mocks.buildPoolConfig }));
vi.mock("../../logger/index.js", () => ({ log: mocks.log }));

const { getPendingWakeForSession } = await import("../wake-db.js");

const SESSION = "00000000-0000-4000-8000-0000000000aa";
const DUE = "2026-07-30T20:57:00.000Z";

beforeEach(() => {
  mocks.buildPoolConfig.mockResolvedValue({
    host: "localhost",
    port: 5432,
    database: "vex",
    user: "vex",
    password: "pw",
  });
  mocks.connect.mockResolvedValue(undefined);
  mocks.end.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("getPendingWakeForSession", () => {
  it("maps a plain timed defer with no watch", async () => {
    mocks.query.mockResolvedValueOnce({
      rows: [{ due_at: new Date(DUE), reason: "waiting for funding", payload: null }],
    });

    await expect(getPendingWakeForSession(SESSION)).resolves.toEqual({
      dueAt: DUE,
      reason: "waiting for funding",
      watchSummary: null,
    });
  });

  it("summarises watch condition TYPES and never leaks the payload", async () => {
    mocks.query.mockResolvedValueOnce({
      rows: [
        {
          due_at: DUE,
          reason: null,
          payload: {
            watchId: "w-1",
            watchVersion: 1,
            conditions: [
              { type: "price", token: "0xdeadbeef", threshold: "1234.5" },
              { type: "balance", wallet: "0xabc" },
              { type: "price", token: "0xfeed", threshold: "9" },
            ],
          },
        },
      ],
    });

    const result = await getPendingWakeForSession(SESSION);

    // Distinct types, stable order, nothing else.
    expect(result).toEqual({ dueAt: DUE, reason: null, watchSummary: "price, balance" });
    const serialised = JSON.stringify(result);
    expect(serialised).not.toContain("0xdeadbeef");
    expect(serialised).not.toContain("threshold");
    expect(serialised).not.toContain("watchId");
  });

  it("returns null when no pending row exists", async () => {
    mocks.query.mockResolvedValueOnce({ rows: [] });
    await expect(getPendingWakeForSession(SESSION)).resolves.toBeNull();
  });

  it("degrades to null (not a throw) when the query fails", async () => {
    mocks.query.mockRejectedValueOnce(new Error("relation does not exist"));
    await expect(getPendingWakeForSession(SESSION)).resolves.toBeNull();
    expect(mocks.log.warn).toHaveBeenCalled();
  });

  it("degrades to null when the DB is not configured", async () => {
    mocks.buildPoolConfig.mockResolvedValueOnce(null);
    await expect(getPendingWakeForSession(SESSION)).resolves.toBeNull();
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it("drops a reason longer than the DTO bound rather than truncating mid-word", async () => {
    mocks.query.mockResolvedValueOnce({
      rows: [{ due_at: DUE, reason: "x".repeat(5_000), payload: null }],
    });
    const result = await getPendingWakeForSession(SESSION);
    // Bounded, and still parseable by the shared schema.
    const { runtimePausedWakeSchema } = await import(
      "../../../shared/schemas/runtime.js"
    );
    expect(runtimePausedWakeSchema.safeParse(result).success).toBe(true);
  });

  it("selects only the three display columns, never the whole row", async () => {
    mocks.query.mockResolvedValueOnce({ rows: [] });
    await getPendingWakeForSession(SESSION);
    const sql = String(mocks.query.mock.calls[0]?.[0]);
    expect(sql).not.toMatch(/SELECT\s+\*/i);
    expect(sql).toContain("status = 'pending'");
  });
});
