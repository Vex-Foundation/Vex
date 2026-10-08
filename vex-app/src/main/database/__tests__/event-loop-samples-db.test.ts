/** K-5: the bounded, fire-and-forget writer for `main_event_loop_samples`. */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  connect: vi.fn(),
  end: vi.fn(),
  buildPoolConfig: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("pg", () => ({
  Client: function MockClient() {
    return { query: mocks.query, connect: mocks.connect, end: mocks.end };
  },
}));
vi.mock("../db-config.js", () => ({ buildPoolConfig: mocks.buildPoolConfig }));
vi.mock("../../logger/index.js", () => ({
  log: { warn: mocks.warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const db = await import("../event-loop-samples-db.js");

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

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

beforeEach(() => {
  vi.clearAllMocks();
  db.resetEventLoopWriteStateForTests();
  mocks.buildPoolConfig.mockResolvedValue({
    host: "127.0.0.1",
    port: 5777,
    database: "vex",
    user: "vex",
    password: "secret",
  });
  mocks.connect.mockResolvedValue(undefined);
  mocks.end.mockResolvedValue(undefined);
  mocks.query.mockResolvedValue({ rows: [], rowCount: 1 });
});

describe("recordEventLoopWindow", () => {
  it("inserts one numbers-only row through the main DB seam", async () => {
    db.recordEventLoopWindow(WINDOW);
    await vi.waitFor(() => expect(mocks.end).toHaveBeenCalledTimes(1));
    expect(mocks.query).toHaveBeenCalledTimes(1);
    const [sql, params] = mocks.query.mock.calls[0] ?? [];
    expect(String(sql)).toContain("INSERT INTO main_event_loop_samples");
    expect(params).toEqual([60_000, 2_900, 10.5, 48.25, 410, 2, 100, 390.5]);
    expect(db.eventLoopWriteStats()).toEqual({ inFlight: 0, dropped: 0 });
  });

  it("skips the row when no DB connection has been handed over yet", async () => {
    mocks.buildPoolConfig.mockResolvedValue(null);
    db.recordEventLoopWindow(WINDOW);
    await settle();
    expect(mocks.connect).not.toHaveBeenCalled();
    expect(db.eventLoopWriteStats().inFlight).toBe(0);
  });

  it("keeps at most one write in flight and counts the dropped window", async () => {
    let finish: () => void = () => undefined;
    const slow = (): Promise<void> =>
      new Promise<void>((resolve) => {
        finish = resolve;
      });
    db.recordEventLoopWindow(WINDOW, slow);
    db.recordEventLoopWindow(WINDOW, slow);
    expect(db.eventLoopWriteStats()).toEqual({ inFlight: 1, dropped: 1 });
    finish();
    await settle();
    expect(db.eventLoopWriteStats()).toEqual({ inFlight: 0, dropped: 1 });
  });

  it("drops a failed write with one warning per error class and never rejects", async () => {
    const missingTable = Object.assign(new Error("relation does not exist"), { code: "42P01" });
    const failing = (): Promise<void> => Promise.reject(missingTable);
    db.recordEventLoopWindow(WINDOW, failing);
    await settle();
    db.recordEventLoopWindow(WINDOW, failing);
    await settle();
    expect(mocks.warn).toHaveBeenCalledTimes(1);
    expect(String(mocks.warn.mock.calls[0]?.[0])).toContain("errorClass=42P01");
    expect(String(mocks.warn.mock.calls[0]?.[0])).not.toContain("relation");
    expect(db.eventLoopWriteStats().inFlight).toBe(0);
  });

  it("stays quiet beyond the seam's own line when Postgres refuses the connect", async () => {
    mocks.connect.mockRejectedValue(new Error("ECONNREFUSED"));
    db.recordEventLoopWindow(WINDOW);
    await vi.waitFor(() => expect(mocks.warn).toHaveBeenCalledTimes(1));
    await settle();
    expect(mocks.warn.mock.calls[0]?.[0]).toBe("[event-loop-db] client.connect failed");
    expect(db.eventLoopWriteStats().inFlight).toBe(0);
  });
});
