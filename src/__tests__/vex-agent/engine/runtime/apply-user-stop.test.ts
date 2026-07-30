/**
 * The ONE idempotent stop transaction shared by the observer path, the
 * finalize-after-local-abort path and the direct-abort path.
 *
 * What is pinned here:
 *   - RUN SCOPING (Codex Wave-1 defect 6): the transaction consumes ONLY the
 *     `stop_terminal` requests naming the run it is stopping. A request naming
 *     a DIFFERENT run — a valid pending stop for a later run — is left
 *     untouched, because a delayed finalizer for run A silently erasing run
 *     B's stop is exactly what run scoping exists to prevent;
 *   - the canonical terminal state: run `stopped` + `user_stopped`, parent
 *     mission `cancelled`;
 *   - idempotency: a second caller on an already-terminal run writes nothing
 *     but still consumes this run's requests;
 *   - LOCK ORDER (Codex Wave-1 defect 5): open control requests are locked
 *     first, the run second, and the request lock is never re-acquired when
 *     the caller already holds it.
 *
 * DB client + repos are mocked; this is the SQL-shape and ordering contract.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

const queryWith = vi.fn();
const queryOneWith = vi.fn();
const executeWith = vi.fn().mockResolvedValue(1);
const rejectWith = vi.fn();
const updateRunStatus = vi.fn();
const setMissionStatus = vi.fn();

/** Every SQL string the transaction issued, in order. */
const sqlLog: string[] = [];

vi.mock("@vex-agent/db/client.js", () => ({
  withTransaction: async <T>(cb: (client: unknown) => Promise<T>): Promise<T> =>
    cb({}),
  queryWith: (exec: unknown, sql: string, params?: unknown[]) => {
    sqlLog.push(sql);
    return queryWith(exec, sql, params);
  },
  queryOneWith: (exec: unknown, sql: string, params?: unknown[]) => {
    sqlLog.push(sql);
    return queryOneWith(exec, sql, params);
  },
  executeWith: (exec: unknown, sql: string, params?: unknown[]) => {
    sqlLog.push(sql);
    return executeWith(exec, sql, params);
  },
}));
vi.mock("@vex-agent/db/repos/approvals.js", () => ({
  rejectWith: (...a: unknown[]) => rejectWith(...a),
}));
vi.mock("@vex-agent/db/repos/mission-runs.js", () => ({
  updateStatus: (...a: unknown[]) => updateRunStatus(...a),
}));
vi.mock("@vex-agent/db/repos/missions.js", () => ({
  setStatus: (...a: unknown[]) => setMissionStatus(...a),
}));

const { applyUserStopTransaction, applyUserStopWithClient } = await import(
  "../../../../vex-agent/engine/runtime/lease-and-status/apply-user-stop.js"
);

const INPUT = { sessionId: "sess-1", missionRunId: "run-1" };

function runRow(status: string) {
  return { id: "run-1", mission_id: "mission-1", status };
}

/** Minimal shape of a locked `runtime_control_requests` row. */
function requestRow(over: Record<string, unknown> = {}) {
  return {
    id: "req-1",
    session_id: "sess-1",
    mission_run_id: "run-1",
    kind: "stop_terminal",
    status: "pending",
    ...over,
  };
}

/** Every `runtime_control_requests` UPDATE the transaction issued. */
function clearCalls(): unknown[][] {
  return executeWith.mock.calls.filter(
    (c) =>
      typeof c[1] === "string" && c[1].includes("UPDATE runtime_control_requests"),
  );
}

afterEach(() => {
  vi.clearAllMocks();
  sqlLog.length = 0;
  executeWith.mockResolvedValue(1);
});

describe("applyUserStopTransaction", () => {
  it("writes the canonical terminal state and releases the lease", async () => {
    queryWith
      .mockResolvedValueOnce([]) // no open control requests
      .mockResolvedValueOnce([{ id: "ap-1" }, { id: "ap-2" }]); // pending approvals
    queryOneWith.mockResolvedValueOnce(runRow("running"));
    rejectWith.mockResolvedValue({ id: "ap-1", status: "rejected" });
    executeWith.mockResolvedValue(3); // wake cancel count

    const out = await applyUserStopTransaction(INPUT);

    expect(out).toEqual({
      outcome: "stopped",
      previousStatus: "running",
      // The winner's discriminator now carries the parent mission id, so the
      // stop-for-edit transition can gate its demotion on having won without a
      // second query (see `apply-stop-for-edit.ts`).
      missionId: "mission-1",
      rejectedApprovals: 2,
      wakeCancelledCount: 3,
      consumedRequests: 0,
    });
    expect(updateRunStatus).toHaveBeenCalledWith(
      "run-1",
      "stopped",
      "user_stopped",
      undefined,
      expect.anything(),
    );
    expect(setMissionStatus).toHaveBeenCalledWith(
      "mission-1",
      "cancelled",
      expect.anything(),
    );
    expect(sqlLog.some((s) => s.includes("DELETE FROM runner_leases"))).toBe(true);
    expect(
      sqlLog.some((s) => s.includes("loop_wake_requests") && s.includes("consumed_by_stop")),
    ).toBe(true);
  });

  it("locks OPEN CONTROL REQUESTS before the RUN (deadlock-free ordering)", async () => {
    queryWith.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    queryOneWith.mockResolvedValueOnce(runRow("running"));

    await applyUserStopTransaction(INPUT);

    const requestsIdx = sqlLog.findIndex((s) =>
      s.includes("FROM runtime_control_requests"),
    );
    const runIdx = sqlLog.findIndex((s) => s.includes("FROM mission_runs"));
    expect(requestsIdx).toBeGreaterThanOrEqual(0);
    expect(runIdx).toBeGreaterThan(requestsIdx);
    // The canonical lock is session-scoped and unfiltered by kind — every stop
    // path must lock the SAME row set in the SAME order or the sets can
    // interleave into a cycle.
    expect(sqlLog[requestsIdx]).toContain("status IN ('pending', 'observed')");
    expect(sqlLog[requestsIdx]).toContain("ORDER BY created_at ASC, id ASC");
    expect(sqlLog[requestsIdx]).not.toContain("SKIP LOCKED");
  });

  it("does NOT re-acquire the request lock when the caller already holds it", async () => {
    // Regression (defect 5): the observer locks the requests, then the run,
    // then delegated here — which re-locked the requests AFTER the run lock and
    // inverted the documented order. Two concurrent observers could deadlock.
    queryWith.mockResolvedValueOnce([]); // approvals only
    queryOneWith.mockResolvedValueOnce(runRow("running"));

    await applyUserStopWithClient({} as never, {
      ...INPUT,
      lockedRequests: [requestRow()],
    });

    expect(
      sqlLog.filter((s) => s.includes("FROM runtime_control_requests")),
    ).toHaveLength(0);
    // …and the caller-supplied row is still consumed.
    expect(clearCalls()).toHaveLength(1);
    expect(clearCalls()[0]![2]).toEqual(["req-1"]);
  });

  it.each([
    ["a different run", "run-OTHER"],
    ["no run at all", null],
  ])(
    "leaves a stop request naming %s ALONE — it is not this run's to erase",
    async (_label, requestRunId) => {
      // Regression (defect 6): a delayed finalizer for run A must never clear a
      // valid pending stop belonging to a later run B. Retiring requests that
      // can never be applied is the observer's job, decided against the run
      // whose checkpoint is actually executing.
      queryWith
        .mockResolvedValueOnce([
          requestRow({ id: "req-other", mission_run_id: requestRunId }),
        ])
        .mockResolvedValueOnce([]);
      queryOneWith.mockResolvedValueOnce(runRow("running"));

      const out = await applyUserStopTransaction(INPUT);

      expect(out).toMatchObject({ outcome: "stopped", consumedRequests: 0 });
      expect(clearCalls()).toHaveLength(0);
    },
  );

  it("consumes a request that names THIS run and skips other kinds", async () => {
    queryWith
      .mockResolvedValueOnce([
        requestRow({ id: "req-pause", kind: "pause_after_step" }),
        requestRow({ id: "req-mine" }),
      ])
      .mockResolvedValueOnce([]);
    queryOneWith.mockResolvedValueOnce(runRow("running"));

    const out = await applyUserStopTransaction(INPUT);

    expect(out).toMatchObject({ outcome: "stopped", consumedRequests: 1 });
    expect(clearCalls()).toHaveLength(1);
    expect(clearCalls()[0]![2]).toEqual(["req-mine"]);
  });

  it("is idempotent — an already-terminal run writes nothing but still consumes its requests", async () => {
    queryWith.mockResolvedValueOnce([requestRow({ id: "req-mine" })]);
    queryOneWith.mockResolvedValueOnce(runRow("stopped"));

    const out = await applyUserStopTransaction(INPUT);

    expect(out).toEqual({
      outcome: "already_terminal",
      currentStatus: "stopped",
      missionId: "mission-1",
      consumedRequests: 1,
    });
    expect(updateRunStatus).not.toHaveBeenCalled();
    expect(setMissionStatus).not.toHaveBeenCalled();
    expect(rejectWith).not.toHaveBeenCalled();
    expect(sqlLog.some((s) => s.includes("DELETE FROM runner_leases"))).toBe(false);
  });

  it("reports run_not_found without writing when the run row is gone", async () => {
    queryWith.mockResolvedValueOnce([]);
    queryOneWith.mockResolvedValueOnce(null);

    const out = await applyUserStopTransaction(INPUT);

    expect(out).toEqual({ outcome: "run_not_found", consumedRequests: 0 });
    expect(updateRunStatus).not.toHaveBeenCalled();
  });

  it("counts only approvals whose CAS actually won", async () => {
    queryWith
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: "ap-1" }, { id: "ap-2" }]);
    queryOneWith.mockResolvedValueOnce(runRow("paused_approval"));
    // ap-2 was resolved by someone else between the SELECT and the CAS.
    rejectWith
      .mockResolvedValueOnce({ id: "ap-1", status: "rejected" })
      .mockResolvedValueOnce(null);

    const out = await applyUserStopTransaction(INPUT);

    expect(out).toMatchObject({ outcome: "stopped", rejectedApprovals: 1 });
  });
});
