/**
 * `observeAndApplyControl` run scoping + lock order.
 *
 * Control requests carry the `mission_run_id` the IPC minted them for.
 * Matching by session alone let a request left over from an EARLIER run
 * pause or terminate a LATER one. This pins the gate: a mismatch is cleared
 * as stale and never applied, and a match is applied to the run the
 * checkpoint actually belongs to (not "whichever run is newest").
 *
 * It also pins the LOCK ORDER (Codex Wave-1 defect 5): the canonical
 * control-request lock is taken FIRST — unfiltered by kind, without
 * `SKIP LOCKED`, in `(created_at, id)` order — and the already-locked rows are
 * handed to the shared stop body so no request lock is ever taken after the
 * run lock. Under the old `FOR UPDATE SKIP LOCKED LIMIT 1` claim, two
 * observers could each hold one request, each lock the run, and each then wait
 * for the other's request row inside the shared stop body.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

const queryWith = vi.fn().mockResolvedValue([]);
const queryOneWith = vi.fn();
const executeWith = vi.fn().mockResolvedValue(1);
const applyUserStopWithClient = vi.fn();

const sqlLog: string[] = [];

vi.mock("@vex-agent/db/client.js", () => ({
  withTransaction: async <T>(cb: (client: unknown) => Promise<T>): Promise<T> =>
    cb({}),
  queryOneWith: (exec: unknown, sql: string, params?: unknown[]) => {
    sqlLog.push(sql);
    return queryOneWith(exec, sql, params);
  },
  executeWith: (exec: unknown, sql: string, params?: unknown[]) => {
    sqlLog.push(sql);
    return executeWith(exec, sql, params);
  },
  queryWith: (exec: unknown, sql: string, params?: unknown[]) => {
    sqlLog.push(sql);
    return queryWith(exec, sql, params);
  },
}));

vi.mock(
  "../../../../vex-agent/engine/runtime/lease-and-status/apply-user-stop.js",
  () => ({
    applyUserStopWithClient: (...a: unknown[]) => applyUserStopWithClient(...a),
  }),
);

const { observeAndApplyControl } = await import(
  "../../../../vex-agent/engine/runtime/lease-and-status/observe-and-apply.js"
);

function requestRow(over: Record<string, unknown> = {}) {
  return {
    id: "req-1",
    session_id: "sess-1",
    mission_run_id: "run-1",
    kind: "stop_terminal",
    status: "pending",
    requested_by: "user",
    reason: null,
    correlation_id: "corr-1",
    created_at: new Date(),
    observed_at: null,
    cleared_at: null,
    expires_at: null,
    ...over,
  };
}

const KINDS = ["pause_after_step", "stop_terminal"] as const;

/** Seed the canonical request lock with `rows`. */
function lockReturns(rows: Array<Record<string, unknown>>): void {
  queryWith.mockResolvedValueOnce(rows);
}

function observe(missionRunId: string | null = "run-1") {
  return observeAndApplyControl({
    sessionId: "sess-1",
    missionRunId,
    kinds: KINDS,
  });
}

afterEach(() => {
  vi.clearAllMocks();
  sqlLog.length = 0;
  queryWith.mockResolvedValue([]);
  executeWith.mockResolvedValue(1);
});

describe("observeAndApplyControl run scoping", () => {
  it("clears a request minted for an EARLIER run instead of stopping this one", async () => {
    lockReturns([requestRow({ mission_run_id: "run-OLD" })]);
    queryOneWith.mockResolvedValueOnce(
      requestRow({ mission_run_id: "run-OLD", status: "observed" }),
    );

    const out = await observe();

    expect(out.outcome).toBe("stale_cleared");
    // Nothing was applied — no run lock, no stop transaction.
    expect(applyUserStopWithClient).not.toHaveBeenCalled();
    expect(sqlLog.some((s) => s.includes("FROM mission_runs"))).toBe(false);
    const clear = executeWith.mock.calls.find(
      (c) => typeof c[1] === "string" && c[1].includes("'cleared'"),
    );
    expect(clear![2]).toEqual(["req-1", "stale_run_mismatch"]);
  });

  it("applies a matching stop through the SHARED stop transaction, handing over the locked rows", async () => {
    const locked = [requestRow()];
    lockReturns(locked);
    queryOneWith
      .mockResolvedValueOnce(requestRow({ status: "observed" }))
      .mockResolvedValueOnce({ id: "run-1", status: "running", session_id: "sess-1" });
    applyUserStopWithClient.mockResolvedValueOnce({
      outcome: "stopped",
      previousStatus: "running",
      rejectedApprovals: 0,
      wakeCancelledCount: 2,
      consumedRequests: 1,
    });

    const out = await observe();

    expect(out).toEqual({
      outcome: "stop_applied",
      request: expect.objectContaining({ id: "req-1", missionRunId: "run-1" }),
      previousStatus: "running",
      terminalStatus: "stopped",
      wakeCancelledCount: 2,
    });
    // Regression (defect 5): the shared body must NOT re-lock the requests
    // after we took the run lock — it gets the rows we already hold.
    expect(applyUserStopWithClient).toHaveBeenCalledWith(expect.anything(), {
      sessionId: "sess-1",
      missionRunId: "run-1",
      lockedRequests: locked,
    });
  });

  it("takes the canonical request lock BEFORE the run lock, unfiltered and without SKIP LOCKED", async () => {
    lockReturns([requestRow()]);
    queryOneWith
      .mockResolvedValueOnce(requestRow({ status: "observed" }))
      .mockResolvedValueOnce({ id: "run-1", status: "running", session_id: "sess-1" });
    applyUserStopWithClient.mockResolvedValueOnce({
      outcome: "stopped",
      previousStatus: "running",
      rejectedApprovals: 0,
      wakeCancelledCount: 0,
      consumedRequests: 1,
    });

    await observe();

    const requestsIdx = sqlLog.findIndex(
      (s) => s.includes("FROM runtime_control_requests") && s.includes("FOR UPDATE"),
    );
    const runIdx = sqlLog.findIndex((s) => s.includes("FROM mission_runs"));
    expect(requestsIdx).toBeGreaterThanOrEqual(0);
    expect(runIdx).toBeGreaterThan(requestsIdx);
    expect(sqlLog[requestsIdx]).not.toContain("SKIP LOCKED");
    // No `kind` predicate: every stop-capable transaction locks the same set.
    expect(sqlLog[requestsIdx]).not.toContain("kind =");
    expect(sqlLog[requestsIdx]).toContain("ORDER BY created_at ASC, id ASC");
  });

  it("picks the oldest PENDING request of a handled kind out of the locked set", async () => {
    lockReturns([
      requestRow({ id: "req-observed", status: "observed" }),
      requestRow({ id: "req-resume", kind: "resume" }),
      requestRow({ id: "req-mine" }),
    ]);
    queryOneWith
      .mockResolvedValueOnce(requestRow({ id: "req-mine", status: "observed" }))
      .mockResolvedValueOnce({ id: "run-1", status: "running", session_id: "sess-1" });
    applyUserStopWithClient.mockResolvedValueOnce({
      outcome: "stopped",
      previousStatus: "running",
      rejectedApprovals: 0,
      wakeCancelledCount: 0,
      consumedRequests: 1,
    });

    await observe();

    const observeUpdate = queryOneWith.mock.calls.find(
      (c) => typeof c[1] === "string" && c[1].includes("SET status      = 'observed'"),
    );
    expect(observeUpdate![2]).toEqual(["req-mine"]);
  });

  it("locks the run BY ID, not 'whichever run is newest'", async () => {
    lockReturns([requestRow()]);
    queryOneWith
      .mockResolvedValueOnce(requestRow({ status: "observed" }))
      .mockResolvedValueOnce({ id: "run-1", status: "running", session_id: "sess-1" });
    applyUserStopWithClient.mockResolvedValueOnce({
      outcome: "stopped",
      previousStatus: "running",
      rejectedApprovals: 0,
      wakeCancelledCount: 0,
      consumedRequests: 1,
    });

    await observe();

    const runLock = queryOneWith.mock.calls.find(
      (c) => typeof c[1] === "string" && c[1].includes("FROM mission_runs"),
    );
    expect(runLock![1]).toContain("WHERE id = $1");
    expect(runLock![2]).toEqual(["run-1"]);
  });

  it("treats an already-terminal run as 'no active run' and never stops it twice", async () => {
    lockReturns([requestRow()]);
    queryOneWith
      .mockResolvedValueOnce(requestRow({ status: "observed" }))
      .mockResolvedValueOnce({ id: "run-1", status: "completed", session_id: "sess-1" });

    const out = await observe();

    expect(out.outcome).toBe("stop_applied");
    expect(applyUserStopWithClient).not.toHaveBeenCalled();
  });

  it("applies a matching pause to the scoped run", async () => {
    lockReturns([requestRow({ kind: "pause_after_step" })]);
    queryOneWith
      .mockResolvedValueOnce(
        requestRow({ kind: "pause_after_step", status: "observed" }),
      )
      .mockResolvedValueOnce({ id: "run-1", status: "running", session_id: "sess-1" });

    const out = await observe();

    expect(out.outcome).toBe("paused_user_applied");
    expect(
      executeWith.mock.calls.some(
        (c) => typeof c[1] === "string" && c[1].includes("'paused_user'"),
      ),
    ).toBe(true);
  });

  it("clears a stale PAUSE request too — same bug class, same gate", async () => {
    lockReturns([
      requestRow({ kind: "pause_after_step", mission_run_id: "run-OLD" }),
    ]);
    queryOneWith.mockResolvedValueOnce(
      requestRow({
        kind: "pause_after_step",
        mission_run_id: "run-OLD",
        status: "observed",
      }),
    );

    const out = await observe();

    expect(out.outcome).toBe("stale_cleared");
    expect(
      executeWith.mock.calls.some(
        (c) => typeof c[1] === "string" && c[1].includes("'paused_user'"),
      ),
    ).toBe(false);
  });

  it("returns no_request when nothing open matches a handled kind", async () => {
    lockReturns([requestRow({ kind: "resume" })]);
    const out = await observe();
    expect(out).toEqual({ outcome: "no_request" });
    expect(sqlLog.some((s) => s.includes("FROM mission_runs"))).toBe(false);
  });

  it("returns no_request when nothing is open at all", async () => {
    lockReturns([]);
    const out = await observe();
    expect(out).toEqual({ outcome: "no_request" });
  });
});
