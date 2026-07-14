/**
 * Unit tests for the loop-wake repo. Pool / PoolClient are mocked; no DB.
 *
 * Scripted-client pattern matches `knowledge-lifecycle.test.ts` for
 * consistency: each claim/cancel/enqueue test declares the sequence of SQL
 * statements expected against the mock client (for `claimDue` we verify
 * BEGIN → UPDATE → COMMIT order and release), and structural assertions
 * check the SQL contains the load-bearing fragments (`FOR UPDATE SKIP
 * LOCKED`, `ON CONFLICT DO NOTHING`, partial-index predicate, etc.).
 */

import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

// ── Mock helpers ────────────────────────────────────────────────────

interface QueryCall { sql: string; params: unknown[] | undefined }

const poolQueryLog: QueryCall[] = [];
const clientQueryLog: QueryCall[] = [];
const clientReleaseSpy = vi.fn();

type PoolQueryOneMock = Mock<(sql: string, params?: unknown[]) => Promise<Record<string, unknown> | null>>;
type PoolExecuteMock = Mock<(sql: string, params?: unknown[]) => Promise<number>>;

function makePoolQueryOneMock(): PoolQueryOneMock {
  return vi.fn<(sql: string, params?: unknown[]) => Promise<Record<string, unknown> | null>>()
    .mockResolvedValue(null);
}

function makePoolExecuteMock(): PoolExecuteMock {
  return vi.fn<(sql: string, params?: unknown[]) => Promise<number>>()
    .mockResolvedValue(0);
}

let mockPoolQueryOne: PoolQueryOneMock;
let mockPoolExecute: PoolExecuteMock;
let mockClientResponses: Array<{ rows: Record<string, unknown>[] } | Error> = [];

function resetMocks() {
  poolQueryLog.length = 0;
  clientQueryLog.length = 0;
  clientReleaseSpy.mockClear();
  mockClientResponses = [];
}

const mockClient = {
  async query(sql: string, params?: unknown[]) {
    clientQueryLog.push({ sql, params });
    const next = mockClientResponses.shift();
    if (next instanceof Error) throw next;
    return next ?? { rows: [] };
  },
  release: () => clientReleaseSpy(),
};

const mockGetPool = vi.fn(() => ({
  connect: async () => mockClient,
}));

vi.mock("@vex-agent/db/client.js", () => ({
  getPool: () => mockGetPool(),
  queryOne: (sql: string, params?: unknown[]) => mockPoolQueryOne(sql, params),
  queryOneWith: (_exec: unknown, sql: string, params?: unknown[]) =>
    mockPoolQueryOne(sql, params),
  execute: (sql: string, params?: unknown[]) => mockPoolExecute(sql, params),
  queryWith: vi.fn(),
  executeWith: vi.fn(),
  query: vi.fn().mockResolvedValue([]),
}));

// Initialize mocks AFTER vi.mock registration so closures see the refs.
mockPoolQueryOne = makePoolQueryOneMock();
mockPoolExecute = makePoolExecuteMock();

// Import under test AFTER mocks are registered.
const loopWake = await import("@vex-agent/db/repos/loop-wake.js");

// ── Fixtures ────────────────────────────────────────────────────────

const NOW = new Date("2026-04-20T10:00:00.000Z");
const DUE = new Date("2026-04-20T10:05:00.000Z");
const SESSION = "session-abc";
const RUN = "run-abc-1234";

function makeRow(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    session_id: SESSION,
    mission_run_id: RUN,
    due_at: DUE.toISOString(),
    status: "pending",
    reason: "waiting for price feed",
    payload: { hint: "v1" },
    created_at: NOW.toISOString(),
    consumed_at: null,
    cancelled_at: null,
    cancelled_reason: null,
    ...overrides,
  };
}

// ── enqueue ─────────────────────────────────────────────────────────

describe("loop-wake repo — enqueue", () => {
  beforeEach(() => {
    resetMocks();
    mockPoolQueryOne = makePoolQueryOneMock();
    mockPoolExecute = makePoolExecuteMock();
  });

  it("inserts a pending row and returns the mapped LoopWakeRequest", async () => {
    mockPoolQueryOne.mockResolvedValueOnce(makeRow());
    const result = await loopWake.enqueue({
      sessionId: SESSION,
      missionRunId: RUN,
      dueAt: DUE,
      reason: "waiting for price feed",
      payload: { hint: "v1" },
    });

    expect(result).not.toBeNull();
    expect(result!.id).toBe("11111111-1111-1111-1111-111111111111");
    expect(result!.sessionId).toBe(SESSION);
    expect(result!.missionRunId).toBe(RUN);
    expect(result!.status).toBe("pending");
    expect(result!.dueAt).toBe(DUE.toISOString());

    const [sql, params] = mockPoolQueryOne.mock.calls[0];
    expect(sql).toContain("INSERT INTO loop_wake_requests");
    expect(sql).toContain("ON CONFLICT (session_id) WHERE status = 'pending' DO NOTHING");
    expect(sql).toContain("RETURNING *");
    // Param positional order matches repo implementation: session_id, mission_run_id, due_at, reason, payload.
    expect(params?.[0]).toBe(SESSION);
    expect(params?.[1]).toBe(RUN);
    expect(params?.[2]).toBe(DUE.toISOString());
    expect(params?.[3]).toBe("waiting for price feed");
    // payload JSONB — stringified when not null.
    expect(params?.[4]).toBe(JSON.stringify({ hint: "v1" }));
  });

  it("returns null when ON CONFLICT fires (already a pending row for this session)", async () => {
    mockPoolQueryOne.mockResolvedValueOnce(null);
    const result = await loopWake.enqueue({
      sessionId: SESSION,
      missionRunId: RUN,
      dueAt: DUE,
      reason: null,
      payload: null,
    });
    expect(result).toBeNull();
  });

  it("passes null payload through as a literal SQL NULL (not the string 'null')", async () => {
    mockPoolQueryOne.mockResolvedValueOnce(makeRow({ payload: null }));
    await loopWake.enqueue({
      sessionId: SESSION,
      missionRunId: RUN,
      dueAt: DUE,
      reason: null,
      payload: null,
    });
    const [, params] = mockPoolQueryOne.mock.calls[0];
    expect(params?.[4]).toBeNull();
  });
});

// ── cancelForSession ────────────────────────────────────────────────

describe("loop-wake repo — cancelForSession", () => {
  beforeEach(() => {
    resetMocks();
    mockPoolQueryOne = makePoolQueryOneMock();
    mockPoolExecute = makePoolExecuteMock();
  });

  it("issues UPDATE targeting only pending rows and returns row count", async () => {
    mockPoolExecute.mockResolvedValueOnce(1);
    const count = await loopWake.cancelForSession(SESSION, "user_preempt");

    expect(count).toBe(1);
    const [sql, params] = mockPoolExecute.mock.calls[0];
    expect(sql).toContain("UPDATE loop_wake_requests");
    expect(sql).toContain("SET status = 'cancelled'");
    expect(sql).toContain("cancelled_at = NOW()");
    expect(sql).toContain("WHERE session_id = $1 AND status = 'pending'");
    expect(params?.[0]).toBe(SESSION);
    expect(params?.[1]).toBe("user_preempt");
  });

  it("returns 0 when no pending row exists (normal preempt on clean session)", async () => {
    mockPoolExecute.mockResolvedValueOnce(0);
    const count = await loopWake.cancelForSession(SESSION, "user_preempt");
    expect(count).toBe(0);
  });
});

describe("loop-wake repo — monotonic promotion", () => {
  beforeEach(() => {
    resetMocks();
    mockPoolQueryOne = makePoolQueryOneMock();
    mockPoolExecute = makePoolExecuteMock();
  });

  it("promotes only a matching pending watch for a paused mission run", async () => {
    mockPoolExecute.mockResolvedValueOnce(1);
    expect(await loopWake.promotePendingWake(SESSION, RUN, "watch-1")).toBe(true);
    const [sql, params] = mockPoolExecute.mock.calls[0];
    expect(sql).toContain("SET due_at = LEAST(wake.due_at, NOW())");
    expect(sql).toContain("wake.status = 'pending'");
    expect(sql).toContain("wake.payload->>'watchId' = $3");
    expect(sql).toContain("run.status = 'paused_wake'");
    expect(params).toEqual([SESSION, RUN, "watch-1"]);
  });

  it.each(["claim_due", "ingress_cancel", "duplicate_tick"]) (
    "drops a %s race when the conditional update affects no row",
    async () => {
      mockPoolExecute.mockResolvedValueOnce(0);
      await expect(loopWake.promotePendingWake(SESSION, RUN, "watch-1")).resolves.toBe(false);
    },
  );

  it("uses the same monotonic predicate for a non-watch safety escalation", async () => {
    mockPoolExecute.mockResolvedValueOnce(1);
    expect(await loopWake.promotePendingWakeForSafety(SESSION, RUN)).toBe(true);
    const [sql] = mockPoolExecute.mock.calls[0];
    expect(sql).toContain("SET due_at = LEAST(wake.due_at, NOW())");
    expect(sql).not.toContain("watchId");
    expect(sql).toContain("run.status = 'paused_wake'");
  });
});

// ── claimDue ────────────────────────────────────────────────────────

describe("loop-wake repo — claimDue (exactly-once)", () => {
  beforeEach(() => {
    resetMocks();
    mockPoolQueryOne = makePoolQueryOneMock();
    mockPoolExecute = makePoolExecuteMock();
  });

  it("uses a dedicated connection with BEGIN/COMMIT wrapping the UPDATE", async () => {
    mockClientResponses = [
      { rows: [] }, // BEGIN
      { rows: [makeRow({ status: "consumed", consumed_at: NOW.toISOString() })] }, // UPDATE
      { rows: [] }, // COMMIT
    ];

    const result = await loopWake.claimDue(NOW, 10);

    expect(result).toHaveLength(1);
    expect(result[0].status).toBe("consumed");
    expect(result[0].consumedAt).toBe(NOW.toISOString());

    // Query order: BEGIN → UPDATE → COMMIT.
    expect(clientQueryLog.map((c) => c.sql.trim().split(/\s+/)[0]?.toUpperCase()))
      .toEqual(["BEGIN", "UPDATE", "COMMIT"]);

    // Structural assertions on the UPDATE body — race-safety contract.
    const updateSql = clientQueryLog[1].sql;
    expect(updateSql).toContain("UPDATE loop_wake_requests");
    expect(updateSql).toContain("SET status = 'consumed'");
    expect(updateSql).toContain("FOR UPDATE SKIP LOCKED");
    expect(updateSql).toContain("WHERE status = 'pending'");
    expect(updateSql).toContain("due_at <= $1::timestamptz");
    expect(updateSql).toContain("LIMIT $2");
    expect(updateSql).toContain("RETURNING *");

    // Connection released on success.
    expect(clientReleaseSpy).toHaveBeenCalledTimes(1);
  });

  it("rolls back and releases when the UPDATE throws, then rethrows", async () => {
    const boom = new Error("connection reset");
    mockClientResponses = [
      { rows: [] }, // BEGIN
      boom,          // UPDATE throws
      { rows: [] }, // ROLLBACK
    ];

    await expect(loopWake.claimDue(NOW, 10)).rejects.toThrow("connection reset");

    // Order: BEGIN → UPDATE (throws) → ROLLBACK.
    const ops = clientQueryLog.map((c) => c.sql.trim().split(/\s+/)[0]?.toUpperCase());
    expect(ops[0]).toBe("BEGIN");
    expect(ops[1]).toBe("UPDATE");
    expect(ops[2]).toBe("ROLLBACK");

    // Connection released even on error (defensive finally).
    expect(clientReleaseSpy).toHaveBeenCalledTimes(1);
  });

  it("returns an empty array when no rows are due", async () => {
    mockClientResponses = [
      { rows: [] }, // BEGIN
      { rows: [] }, // UPDATE — nothing claimed
      { rows: [] }, // COMMIT
    ];
    const result = await loopWake.claimDue(NOW, 10);
    expect(result).toEqual([]);
    expect(clientReleaseSpy).toHaveBeenCalledTimes(1);
  });
});

// ── getPendingForSession ────────────────────────────────────────────

describe("loop-wake repo — getPendingForSession", () => {
  beforeEach(() => {
    resetMocks();
    mockPoolQueryOne = makePoolQueryOneMock();
    mockPoolExecute = makePoolExecuteMock();
  });

  it("selects the pending row for a session, or null", async () => {
    mockPoolQueryOne.mockResolvedValueOnce(makeRow());
    const result = await loopWake.getPendingForSession(SESSION);
    expect(result).not.toBeNull();
    expect(result!.sessionId).toBe(SESSION);
    expect(result!.status).toBe("pending");

    const [sql, params] = mockPoolQueryOne.mock.calls[0];
    expect(sql).toContain("SELECT * FROM loop_wake_requests");
    expect(sql).toContain("WHERE session_id = $1 AND status = 'pending'");
    expect(sql).toContain("LIMIT 1");
    expect(params?.[0]).toBe(SESSION);
  });

  it("returns null when nothing is pending", async () => {
    mockPoolQueryOne.mockResolvedValueOnce(null);
    const result = await loopWake.getPendingForSession(SESSION);
    expect(result).toBeNull();
  });
});

// ── mapRow behaviour via enqueue return ─────────────────────────────

describe("loop-wake repo — row mapping", () => {
  beforeEach(() => {
    resetMocks();
    mockPoolQueryOne = makePoolQueryOneMock();
    mockPoolExecute = makePoolExecuteMock();
  });

  it("normalizes Date timestamps coming from pg to ISO strings", async () => {
    const dueDate = new Date(DUE);
    const createdDate = new Date(NOW);
    mockPoolQueryOne.mockResolvedValueOnce(
      makeRow({ due_at: dueDate, created_at: createdDate }),
    );
    const result = await loopWake.enqueue({
      sessionId: SESSION, missionRunId: RUN,
      dueAt: DUE, reason: null, payload: null,
    });
    expect(result!.dueAt).toBe(DUE.toISOString());
    expect(result!.createdAt).toBe(NOW.toISOString());
  });

  it("preserves null consumed_at / cancelled_at / payload / reason", async () => {
    mockPoolQueryOne.mockResolvedValueOnce(
      makeRow({
        consumed_at: null,
        cancelled_at: null,
        cancelled_reason: null,
        payload: null,
        reason: null,
      }),
    );
    const result = await loopWake.enqueue({
      sessionId: SESSION, missionRunId: RUN,
      dueAt: DUE, reason: null, payload: null,
    });
    expect(result!.consumedAt).toBeNull();
    expect(result!.cancelledAt).toBeNull();
    expect(result!.cancelledReason).toBeNull();
    expect(result!.payload).toBeNull();
    expect(result!.reason).toBeNull();
  });
});
