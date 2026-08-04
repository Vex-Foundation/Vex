/**
 * mission-runs-db tests — empty + active row mapping + defensive status.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type QueryFn = (
  text: string,
  params?: readonly unknown[],
) => Promise<{ rows: ReadonlyArray<Record<string, unknown>> }>;

const mocks = vi.hoisted(() => ({
  query: vi.fn() as QueryFn,
  connect: vi.fn(),
  end: vi.fn(),
  buildPoolConfig: vi.fn(),
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("pg", () => {
  function MockClient() {
    return {
      connect: mocks.connect,
      end: mocks.end,
      query: mocks.query,
    };
  }
  return { Client: MockClient };
});

vi.mock("../db-config.js", () => ({
  buildPoolConfig: mocks.buildPoolConfig,
}));

vi.mock("../../logger/index.js", () => ({ log: mocks.log }));

vi.mock("../../logger/index.js", () => ({ log: mocks.log }));

const { getActiveRunForSession, getLatestRunForSession } = await import(
  "../mission-runs-db.js"
);

const SESSION = "00000000-0000-4000-8000-00000000eeee";
const CORRELATION = "22222222-2222-4222-8222-222222222222";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.buildPoolConfig.mockResolvedValue({
    host: "127.0.0.1",
    port: 5777,
    database: "vex",
    user: "vex",
    password: "secret",
  });
  mocks.connect.mockResolvedValue(undefined);
  mocks.end.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("mission-runs-db mapper", () => {
  it("returns inactive shape when session has no active/paused mission run", async () => {
    // ONE always-returning statement now: the aggregate drives off a one-row
    // subquery, so "this session has no run" arrives as a row with null run
    // columns rather than as an absence needing a second, differently-timed
    // query. That second snapshot is exactly what could disagree with the
    // first about a fact the Stop control turns on.
    mocks.query.mockResolvedValueOnce({
      rows: [{
        mission_run_id: null,
        status: null,
        started_at: null,
        last_checkpoint_at: null,
        stop_reason: null,
        iteration_count: null,
        lease_active: false,
        lease_expires_at: null,
        pending_control_kind: null,
        has_pending_wake: false,
        has_pending_approval: false,
        has_incomplete_approval_lifecycle: false,
      }],
    });
    const result = await getActiveRunForSession(SESSION, CORRELATION);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual({
      sessionId: SESSION,
      hasActiveRun: false,
      missionRunId: null,
      status: null,
      stopReason: null,
      lastCheckpointAt: null,
      startedAt: null,
      iterationCount: null,
      leaseActive: false,
      leaseExpiresAt: null,
      pendingControlKind: null,
    });
  });

  it("maps an active mission run row with lease and pending-control fields", async () => {
    mocks.query.mockResolvedValueOnce({
      rows: [
        {
          mission_run_id: "run-1",
          status: "running",
          started_at: "2026-05-21T09:00:00.000Z",
          last_checkpoint_at: "2026-05-21T10:00:00.000Z",
          stop_reason: null,
          iteration_count: "12",
          lease_active: true,
          lease_expires_at: new Date("2026-05-21T10:05:00.000Z"),
          pending_control_kind: null,
        },
      ],
    });
    const result = await getActiveRunForSession(SESSION, CORRELATION);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.hasActiveRun).toBe(true);
    expect(result.data.missionRunId).toBe("run-1");
    expect(result.data.status).toBe("running");
    expect(result.data.iterationCount).toBe(12);
    expect(result.data.leaseActive).toBe(true);
    expect(result.data.leaseExpiresAt).toBe("2026-05-21T10:05:00.000Z");
    expect(result.data.pendingControlKind).toBeNull();
  });

  it("accepts paused_user as a valid active status", async () => {
    mocks.query.mockResolvedValueOnce({
      rows: [
        {
          mission_run_id: "run-2",
          status: "paused_user",
          started_at: "2026-05-21T09:00:00.000Z",
          last_checkpoint_at: null,
          stop_reason: "user_paused",
          iteration_count: 0,
          lease_active: false,
          lease_expires_at: null,
          pending_control_kind: null,
        },
      ],
    });
    const result = await getActiveRunForSession(SESSION, CORRELATION);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.status).toBe("paused_user");
    expect(result.data.hasActiveRun).toBe(true);
    expect(result.data.missionRunId).toBe("run-2");
    expect(result.data.stopReason).toBe("user_paused");
  });

  it("dbUnavailable maps to internal.unexpected with domain=runtime", async () => {
    mocks.buildPoolConfig.mockReset();
    mocks.buildPoolConfig.mockResolvedValueOnce(null);
    const result = await getActiveRunForSession(SESSION, CORRELATION);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("internal.unexpected");
    expect(result.error.domain).toBe("runtime");
  });
});

describe("getLatestRunForSession — lease-active mapping (WP-C)", () => {
  // `vi.mocked` re-types the hoisted `QueryFn`-cast mock so the vitest Mock
  // API (`mockResolvedValueOnce`) is visible without re-triggering the
  // file's pre-existing `QueryFn`-cast type-baseline pattern.
  const q = vi.mocked(mocks.query);

  it("returns null when the session never had a run", async () => {
    q.mockResolvedValueOnce({ rows: [] });
    const result = await getLatestRunForSession(SESSION, CORRELATION);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toBeNull();
  });

  it("maps lease_active=true through for a running row with a live lease", async () => {
    q.mockResolvedValueOnce({
      rows: [{ id: "run-1", status: "running", lease_active: true }],
    });
    const result = await getLatestRunForSession(SESSION, CORRELATION);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual({
      missionRunId: "run-1",
      status: "running",
      leaseActive: true,
    });
  });

  it("maps a NULL lease join (no runner_leases row) to leaseActive=false", async () => {
    q.mockResolvedValueOnce({
      rows: [{ id: "run-1", status: "running", lease_active: null }],
    });
    const result = await getLatestRunForSession(SESSION, CORRELATION);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data?.leaseActive).toBe(false);
  });

  it("rejects an unrecognized status defensively", async () => {
    q.mockResolvedValueOnce({
      rows: [{ id: "run-1", status: "not_a_real_status", lease_active: false }],
    });
    const result = await getLatestRunForSession(SESSION, CORRELATION);
    expect(result.ok).toBe(false);
  });
});
