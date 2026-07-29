/**
 * The DURABLE CONSUMER for a queued operator Stop, at the park-to-`paused_error`
 * boundary.
 *
 * The gap being closed: the only reader of an open `stop_terminal` row is
 * `observeAndApplyControl`, whose only caller is the turn-loop iteration
 * checkpoint. A run parked in `paused_error` reaches no further iteration
 * boundary, so a Stop queued a moment earlier sat `pending` forever unless the
 * operator happened to resume that same run — and never if they did not. Worse,
 * an auto-retry wake (2–32 s backoff) could then resume a run the operator had
 * already stopped.
 *
 * The consumer therefore lives in the PARKING transaction rather than in a
 * periodic sweep. What is pinned here:
 *   - a queued Stop is applied instead of the park (fail-closed: nothing is
 *     resumed, dispatched, or scheduled);
 *   - the gate runs under the session control lock, in the same transaction as
 *     the park, so a Stop cannot slip between them;
 *   - with no queued Stop the park behaves exactly as before;
 *   - applying an already-applied Stop is a no-op.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockAcquireSessionControlLock = vi.fn();
const mockGateOnOperatorStop = vi.fn();
const mockUpdateStatus = vi.fn();
const mockIncrementErrorRetryCount = vi.fn();
const mockQueryOneWith = vi.fn();

/** One fake client threaded through the whole transaction body. */
const fakeClient = { id: "fake-client" };

vi.mock("../../../../../vex-agent/db/client.js", () => ({
  withTransaction: (fn: (c: unknown) => Promise<unknown>) => fn(fakeClient),
  queryOneWith: (...a: unknown[]) => mockQueryOneWith(...a),
}));

vi.mock(
  "../../../../../vex-agent/engine/runtime/lease-and-status/operator-stop-boundary.js",
  () => ({
    gateOnOperatorStopWithClient: (...a: unknown[]) => mockGateOnOperatorStop(...a),
  }),
);

vi.mock(
  "../../../../../vex-agent/engine/runtime/lease-and-status/session-control-lock.js",
  () => ({
    acquireSessionControlLock: (...a: unknown[]) =>
      mockAcquireSessionControlLock(...a),
  }),
);

vi.mock("../../../../../vex-agent/db/repos/mission-runs.js", () => ({
  updateStatus: (...a: unknown[]) => mockUpdateStatus(...a),
  incrementErrorRetryCount: (...a: unknown[]) => mockIncrementErrorRetryCount(...a),
}));

vi.mock("../../../../../vex-agent/db/repos/loop-wake.js", () => ({
  enqueue: vi.fn(),
  cancelForSession: vi.fn(),
}));

const { persistErrorPauseWithMaybeAutoRetry } = await import(
  "../../../../../vex-agent/engine/core/runner/mission-auto-retry.js"
);

const INPUT = {
  runId: "run-1",
  sessionId: "sess-1",
  err: new Error("provider exploded"),
  summary: "provider exploded",
  evidenceBase: { occurredAt: "2026-07-29T00:00:00.000Z" },
};

/** A live, auto-retry-INELIGIBLE run, so the assertions isolate the stop gate. */
const LIVE_RUN_ROW = {
  status: "running",
  stop_reason: null,
  error_retry_count: 0,
  auto_retry_unsafe: false,
  contract_snapshot_json: null,
  permission: "restricted",
};

describe("paused_error park — durable operator-Stop consumer", () => {
  beforeEach(() => {
    mockAcquireSessionControlLock.mockReset().mockResolvedValue(undefined);
    mockGateOnOperatorStop.mockReset();
    mockUpdateStatus.mockReset().mockResolvedValue(undefined);
    mockIncrementErrorRetryCount.mockReset();
    mockQueryOneWith.mockReset().mockResolvedValue(LIVE_RUN_ROW);
  });

  it("applies a queued Stop instead of parking, and schedules nothing", async () => {
    mockGateOnOperatorStop.mockResolvedValue({ kind: "stopped", runStatus: "stopped" });

    const decision = await persistErrorPauseWithMaybeAutoRetry(INPUT, Date.now());

    expect(decision).toEqual({ scheduled: null, persisted: false });
    // FAIL-CLOSED: no park write, no retry increment, no wake.
    expect(mockUpdateStatus).not.toHaveBeenCalled();
    expect(mockIncrementErrorRetryCount).not.toHaveBeenCalled();
  });

  it("takes the session control lock BEFORE the gate, on the park transaction's own client", async () => {
    mockGateOnOperatorStop.mockResolvedValue({ kind: "stopped", runStatus: "stopped" });

    await persistErrorPauseWithMaybeAutoRetry(INPUT, Date.now());

    // The advisory lock is what orders this against a `stop_terminal` INSERT
    // that does not exist yet; a row lock alone cannot. Same client as the
    // park, so gate and park commit together.
    expect(mockAcquireSessionControlLock).toHaveBeenCalledWith(fakeClient, "sess-1");
    expect(mockGateOnOperatorStop).toHaveBeenCalledWith(fakeClient, {
      sessionId: "sess-1",
      missionRunId: "run-1",
    });
    expect(
      mockAcquireSessionControlLock.mock.invocationCallOrder[0]!,
    ).toBeLessThan(mockGateOnOperatorStop.mock.invocationCallOrder[0]!);
  });

  it("parks normally when no Stop is queued", async () => {
    mockGateOnOperatorStop.mockResolvedValue({ kind: "clear" });

    const decision = await persistErrorPauseWithMaybeAutoRetry(INPUT, Date.now());

    expect(decision.persisted).toBe(true);
    expect(mockUpdateStatus).toHaveBeenCalledWith(
      "run-1",
      "paused_error",
      "provider_error",
      expect.objectContaining({ summary: "provider exploded" }),
      fakeClient,
    );
  });

  it("is idempotent — an already-applied Stop leaves the run terminal and writes nothing", async () => {
    // The gate reports `stopped` for an already-terminal run without
    // re-applying anything, so a second pass looks identical to the first.
    mockGateOnOperatorStop.mockResolvedValue({ kind: "stopped", runStatus: "stopped" });

    const first = await persistErrorPauseWithMaybeAutoRetry(INPUT, Date.now());
    const second = await persistErrorPauseWithMaybeAutoRetry(INPUT, Date.now());

    expect(first).toEqual(second);
    expect(mockUpdateStatus).not.toHaveBeenCalled();
  });
});
