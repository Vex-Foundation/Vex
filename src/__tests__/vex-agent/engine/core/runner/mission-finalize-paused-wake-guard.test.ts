/**
 * Mission-finalize regression — the `paused_wake` arm is a RECOVERY write and
 * must go through the terminal-safe CAS, exactly like the
 * `compact_unable_at_critical` arm next to it.
 *
 * The bug this pins: `iteration_limit` / `timeout` parked the run with the
 * unconditional `updateStatus`, so an operator Stop that landed while the
 * runtime slice was unwinding was overwritten — the run came back as
 * `paused_wake` — AND a continuation wake stayed enqueued against it, so the
 * loop-wake executor would resume a run the user had stopped. The scheduled
 * wake is the worse half of the defect, which is why the refusal must also
 * cancel it.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockMissionRunsUpdateStatus = vi.fn();
const mockMissionRunsUpdateStatusIfNotTerminal = vi.fn().mockResolvedValue(true);
const mockMissionsSetStatus = vi.fn();
const mockMissionsClearApprovedAt = vi.fn();
const mockConsumeAbortIntent = vi.fn().mockReturnValue(null);
const mockScheduleRuntimeContinuation = vi.fn();
const mockIsContinuableRuntimeStop = vi.fn().mockReturnValue(true);
const mockCancelForSession = vi.fn().mockResolvedValue(1);

// The `paused_wake` park now carries the durable operator-Stop consumer, so it
// reaches the runtime control plane. Stubbed to "no stop raced us" here; the
// consumer's own behaviour is pinned by
// `runtime-continuation-stop-consumer.test.ts`.
const mockGateOnOperatorStop = vi.fn();
vi.mock("@vex-agent/engine/runtime/lease-and-status.js", () => ({
  gateOnOperatorStopWithClient: (...a: unknown[]) => mockGateOnOperatorStop(...a),
  withSessionControlLock: async <T>(
    _sessionId: string,
    fn: (client: unknown) => Promise<T>,
  ): Promise<T> => fn({}),
}));

vi.mock("@vex-agent/db/repos/missions.js", () => ({
  setStatus: (...a: unknown[]) => mockMissionsSetStatus(...a),
  clearApprovedAt: (...a: unknown[]) => mockMissionsClearApprovedAt(...a),
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

import { finalizeMissionRunStatus } from "../../../../../vex-agent/engine/core/runner/mission-finalize.js";

describe("finalizeMissionRunStatus — continuable runtime stop (paused_wake)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsContinuableRuntimeStop.mockReturnValue(true);
    mockConsumeAbortIntent.mockReturnValue(null);
    mockMissionRunsUpdateStatusIfNotTerminal.mockResolvedValue(true);
    mockGateOnOperatorStop.mockResolvedValue({ kind: "clear" });
    mockScheduleRuntimeContinuation.mockResolvedValue({
      dueAt: "2026-07-28T00:00:05Z",
      enqueued: true,
    });
  });

  it("parks the run through the terminal-safe CAS, never the unconditional write", async () => {
    const result = await finalizeMissionRunStatus(
      "mission-1",
      "run-1",
      "session-1",
      "iteration_limit",
    );

    expect(result).toBe("running");
    expect(mockMissionRunsUpdateStatus).not.toHaveBeenCalled();
    expect(mockMissionRunsUpdateStatusIfNotTerminal).toHaveBeenCalledTimes(1);
    const [runId, status, reason, payload] =
      mockMissionRunsUpdateStatusIfNotTerminal.mock.calls[0]!;
    expect(runId).toBe("run-1");
    expect(status).toBe("paused_wake");
    expect(reason).toBe("waiting_for_wake");
    expect(payload).toMatchObject({
      evidence: { trigger: "iteration_limit", dueAt: "2026-07-28T00:00:05Z", enqueued: true },
    });
    // Happy path: the scheduled continuation stands.
    expect(mockCancelForSession).not.toHaveBeenCalled();
  });

  it("a run that went terminal during the slice is NOT re-opened AND its wake is cancelled", async () => {
    mockMissionRunsUpdateStatusIfNotTerminal.mockResolvedValue(false);

    const result = await finalizeMissionRunStatus(
      "mission-1",
      "run-1",
      "session-1",
      "timeout",
    );

    expect(result).toBe("running");
    // No unguarded second write, and the mission row is left as the stop
    // transaction wrote it.
    expect(mockMissionRunsUpdateStatus).not.toHaveBeenCalled();
    expect(mockMissionsSetStatus).not.toHaveBeenCalled();
    // The continuation must not survive the refusal — otherwise the executor
    // wakes a stopped run.
    expect(mockCancelForSession).toHaveBeenCalledTimes(1);
    expect(mockCancelForSession.mock.calls[0]![0]).toBe("session-1");
  });

  it("does not cancel a pre-existing wake it did not enqueue", async () => {
    // `enqueued: false` means the partial unique index kept an EXISTING pending
    // wake. Cancelling it would be this arm reaching outside its own write.
    mockScheduleRuntimeContinuation.mockResolvedValue({
      dueAt: "2026-07-28T00:00:05Z",
      enqueued: false,
    });
    mockMissionRunsUpdateStatusIfNotTerminal.mockResolvedValue(false);

    await finalizeMissionRunStatus("mission-1", "run-1", "session-1", "timeout");

    expect(mockCancelForSession).not.toHaveBeenCalled();
  });
});
