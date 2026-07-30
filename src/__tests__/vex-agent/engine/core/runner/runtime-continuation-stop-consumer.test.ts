/**
 * DURABLE operator-Stop consumer at the CONTINUABLE-runtime park
 * (`mission-finalize.ts`, `paused_wake` / `waiting_for_wake`).
 *
 * Site-specific hazard: this arm ENQUEUES a continuation wake BEFORE it parks
 * (deliberate ordering, documented at the call site — a Stop landing between a
 * successful CAS and a later enqueue would leave a wake scheduled on a stopped
 * run). So when the gate consumes a queued Stop instead of parking, the wake
 * this arm just enqueued must be cancelled too, exactly as the refused-CAS
 * branch already does. A gate-stopped park that left the wake behind would hand
 * the executor a stopped run to resume — the worse half of the original defect.
 *
 * Pinned here: gate consulted under the lock on the park's own client; no park
 * write when it reports `stopped`; the arm's own wake cancelled; a wake it did
 * NOT enqueue left alone; the caller's `"running"` return unchanged.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockMissionRunsUpdateStatus = vi.fn();
const mockMissionRunsUpdateStatusIfNotTerminal = vi.fn();
const mockMissionsSetStatus = vi.fn();
const mockConsumeAbortIntent = vi.fn();
const mockScheduleRuntimeContinuation = vi.fn();
const mockIsContinuableRuntimeStop = vi.fn();
const mockCancelForSession = vi.fn();
const mockGateOnOperatorStop = vi.fn();
const mockWithSessionControlLock = vi.fn();
const mockLoggerWarn = vi.fn();

/** One fake client threaded through the whole park transaction. */
const fakeClient = { id: "fake-client" };

vi.mock("@vex-agent/engine/runtime/lease-and-status.js", () => ({
  gateOnOperatorStopWithClient: (...a: unknown[]) => mockGateOnOperatorStop(...a),
  withSessionControlLock: (...a: unknown[]) => mockWithSessionControlLock(...a),
}));

vi.mock("@vex-agent/db/repos/missions.js", () => ({
  setStatus: (...a: unknown[]) => mockMissionsSetStatus(...a),
  clearApprovedAt: vi.fn(),
}));

vi.mock("@vex-agent/db/repos/mission-runs.js", () => ({
  updateStatus: (...a: unknown[]) => mockMissionRunsUpdateStatus(...a),
  updateStatusIfNotTerminal: (...a: unknown[]) =>
    mockMissionRunsUpdateStatusIfNotTerminal(...a),
}));

vi.mock("@vex-agent/db/repos/loop-wake.js", () => ({
  cancelForSession: (...a: unknown[]) => mockCancelForSession(...a),
}));

vi.mock("../../../../../vex-agent/engine/core/runner/abort.js", () => ({
  consumeMissionRunAbortIntent: (...a: unknown[]) => mockConsumeAbortIntent(...a),
}));

vi.mock("../../../../../vex-agent/engine/core/runner/runtime-continuation.js", () => ({
  isContinuableRuntimeStop: (...a: unknown[]) => mockIsContinuableRuntimeStop(...a),
  scheduleRuntimeContinuation: (...a: unknown[]) =>
    mockScheduleRuntimeContinuation(...a),
}));

vi.mock("@utils/logger.js", () => ({
  default: {
    info: vi.fn(),
    warn: (...a: unknown[]) => mockLoggerWarn(...a),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

const { finalizeMissionRunStatus } = await import(
  "../../../../../vex-agent/engine/core/runner/mission-finalize.js"
);

describe("paused_wake continuation park — durable operator-Stop consumer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsContinuableRuntimeStop.mockReturnValue(true);
    mockConsumeAbortIntent.mockReturnValue(null);
    mockMissionRunsUpdateStatusIfNotTerminal.mockResolvedValue(true);
    mockCancelForSession.mockResolvedValue(1);
    mockScheduleRuntimeContinuation.mockResolvedValue({
      dueAt: "2026-07-29T00:00:05Z",
      enqueued: true,
    });
    mockGateOnOperatorStop.mockResolvedValue({ kind: "clear" });
    mockWithSessionControlLock.mockImplementation(
      async (_sessionId: string, fn: (c: unknown) => Promise<unknown>) =>
        fn(fakeClient),
    );
  });

  it("runs the gate under the session control lock, on the park's own client", async () => {
    await finalizeMissionRunStatus(
      "mission-1",
      "run-1",
      "session-1",
      "iteration_limit",
    );

    expect(mockWithSessionControlLock).toHaveBeenCalledTimes(1);
    expect(mockWithSessionControlLock.mock.calls[0]![0]).toBe("session-1");
    expect(mockGateOnOperatorStop).toHaveBeenCalledWith(fakeClient, {
      sessionId: "session-1",
      missionRunId: "run-1",
    });
    // Gate and park commit together — same client, one transaction.
    expect(
      mockMissionRunsUpdateStatusIfNotTerminal.mock.calls[0]!.at(-1),
    ).toBe(fakeClient);
  });

  it("applies a queued Stop instead of parking, and cancels the wake it enqueued", async () => {
    mockGateOnOperatorStop.mockResolvedValue({
      kind: "stopped",
      runStatus: "stopped",
    });

    const result = await finalizeMissionRunStatus(
      "mission-1",
      "run-1",
      "session-1",
      "iteration_limit",
    );

    // FAIL-CLOSED: no park write of any kind.
    expect(mockMissionRunsUpdateStatusIfNotTerminal).not.toHaveBeenCalled();
    expect(mockMissionRunsUpdateStatus).not.toHaveBeenCalled();
    // The wake this arm enqueued must NOT survive the stop.
    expect(mockCancelForSession).toHaveBeenCalledTimes(1);
    expect(mockCancelForSession.mock.calls[0]![0]).toBe("session-1");
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      "engine.mission.runtime_continuation_after_terminal",
      expect.objectContaining({ runId: "run-1", wakeCancelled: true }),
    );
    // The mission row is left exactly as the stop transaction wrote it, and the
    // return value is unchanged from the refused-CAS branch.
    expect(mockMissionsSetStatus).not.toHaveBeenCalled();
    expect(result).toBe("running");
  });

  it("does not cancel a pre-existing wake it did not enqueue, even on gate-stopped", async () => {
    mockScheduleRuntimeContinuation.mockResolvedValue({
      dueAt: "2026-07-29T00:00:05Z",
      enqueued: false,
    });
    mockGateOnOperatorStop.mockResolvedValue({
      kind: "stopped",
      runStatus: "stopped",
    });

    await finalizeMissionRunStatus("mission-1", "run-1", "session-1", "timeout");

    expect(mockCancelForSession).not.toHaveBeenCalled();
  });

  it("parks normally when no Stop is queued", async () => {
    const result = await finalizeMissionRunStatus(
      "mission-1",
      "run-1",
      "session-1",
      "iteration_limit",
    );

    expect(result).toBe("running");
    expect(mockMissionRunsUpdateStatus).not.toHaveBeenCalled();
    const [runId, status, reason] =
      mockMissionRunsUpdateStatusIfNotTerminal.mock.calls[0]!;
    expect(runId).toBe("run-1");
    expect(status).toBe("paused_wake");
    expect(reason).toBe("waiting_for_wake");
    expect(mockCancelForSession).not.toHaveBeenCalled();
  });
});
