/**
 * TERMINAL-STOP PRECEDENCE for the BUSINESS-OUTCOME and `system_error` arms of
 * `finalizeMissionRunStatus`.
 *
 * The invariant: a terminal user Stop (`stopped` / `user_stopped`) must never be
 * overwritten or reopened by any other write. `completed` / `failed` are real
 * outcomes the agent reached, but they are decided from a turn-loop result that
 * is arbitrarily stale by the time finalize lands — an operator Stop can have
 * committed in between. The Stop wins.
 *
 * Two things this pins beyond "the run row survives":
 *   1. The RUN transition is attempted FIRST and the PARENT MISSION row is only
 *      updated when that CAS wins. The previous order (`missions.setStatus` then
 *      `missionRuns.updateStatus`) could mark the mission `completed` even when
 *      the run write lost the race.
 *   2. A superseded outcome is not reported as truth: the function returns
 *      `cancelled` (the mission-level terminal the stop transaction already
 *      wrote), and the `system_error` arm does not emit a bug report claiming
 *      `runtimeStatus: "failed"` for a run that is actually `stopped` — the same
 *      rule `finalizeMissionRunError` already applies on its terminal branch.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockUpdateStatus = vi.fn();
const mockUpdateStatusIfNotTerminal = vi.fn().mockResolvedValue(true);
const mockMissionsSetStatus = vi.fn();
const mockMissionsClearApprovedAt = vi.fn();
const mockConsumeAbortIntent = vi.fn().mockReturnValue(null);
const mockIsContinuableRuntimeStop = vi.fn().mockReturnValue(false);
const mockScheduleRuntimeContinuation = vi
  .fn()
  .mockResolvedValue({ dueAt: "2026-07-29T00:00:00Z", enqueued: true });
const mockShouldTerminateRun = vi.fn().mockReturnValue(false);
const mockEmitBugReportSafe = vi.fn().mockResolvedValue(undefined);
const mockLoggerWarn = vi.fn();

vi.mock("@vex-agent/db/repos/missions.js", () => ({
  setStatus: (...a: unknown[]) => mockMissionsSetStatus(...a),
  clearApprovedAt: (...a: unknown[]) => mockMissionsClearApprovedAt(...a),
}));

vi.mock("@vex-agent/db/repos/mission-runs.js", () => ({
  updateStatus: (...a: unknown[]) => mockUpdateStatus(...a),
  updateStatusIfNotTerminal: (...a: unknown[]) => mockUpdateStatusIfNotTerminal(...a),
}));

vi.mock("../../../../../vex-agent/engine/core/runner/abort.js", () => ({
  consumeMissionRunAbortIntent: (...a: unknown[]) => mockConsumeAbortIntent(...a),
}));

vi.mock("../../../../../vex-agent/engine/core/runner/runtime-continuation.js", () => ({
  isContinuableRuntimeStop: (...a: unknown[]) => mockIsContinuableRuntimeStop(...a),
  scheduleRuntimeContinuation: (...a: unknown[]) =>
    mockScheduleRuntimeContinuation(...a),
}));

vi.mock("../../../../../vex-agent/engine/core/stop-conditions.js", () => ({
  shouldTerminateRun: (...a: unknown[]) => mockShouldTerminateRun(...a),
}));

vi.mock("../../../../../vex-agent/engine/support/bug-report-registry.js", () => ({
  getBugReportSink: () => null,
}));

vi.mock("../../../../../lib/diagnostics/bug-report-sink.js", () => ({
  emitBugReportSafe: (...a: unknown[]) => mockEmitBugReportSafe(...a),
}));

vi.mock("@utils/logger.js", () => ({
  default: {
    info: vi.fn(),
    warn: (...a: unknown[]) => mockLoggerWarn(...a),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { finalizeMissionRunStatus } from "../../../../../vex-agent/engine/core/runner/mission-finalize.js";

describe("finalizeMissionRunStatus — terminal-stop precedence, business outcome", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpdateStatusIfNotTerminal.mockResolvedValue(true);
    mockConsumeAbortIntent.mockReturnValue(null);
    mockIsContinuableRuntimeStop.mockReturnValue(false);
    mockShouldTerminateRun.mockReturnValue(true);
  });

  it("goal_reached lands `completed` through the CAS, then updates the mission", async () => {
    const result = await finalizeMissionRunStatus(
      "mission-1",
      "run-1",
      "session-1",
      "goal_reached",
      { summary: "done" },
    );

    expect(result).toBe("completed");
    expect(mockUpdateStatus).not.toHaveBeenCalled();
    expect(mockUpdateStatusIfNotTerminal).toHaveBeenCalledTimes(1);
    const [runId, status, reason, payload] =
      mockUpdateStatusIfNotTerminal.mock.calls[0]!;
    expect(runId).toBe("run-1");
    expect(status).toBe("completed");
    expect(reason).toBe("goal_reached");
    expect(payload).toMatchObject({ summary: "done" });
    expect(mockMissionsSetStatus).toHaveBeenCalledWith("mission-1", "completed");
  });

  it("does not overwrite a Stop that landed first, and leaves the mission row alone", async () => {
    // The Stop committed while the loop was unwinding: the CAS refuses.
    mockUpdateStatusIfNotTerminal.mockResolvedValue(false);

    const result = await finalizeMissionRunStatus(
      "mission-1",
      "run-1",
      "session-1",
      "goal_reached",
      { summary: "done" },
    );

    // No unconditional write may reach the terminal row.
    expect(mockUpdateStatus).not.toHaveBeenCalled();
    // The losing writer must not touch the parent mission either — the stop
    // transaction already set it to `cancelled`.
    expect(mockMissionsSetStatus).not.toHaveBeenCalled();
    // And it must not report the superseded outcome as truth.
    expect(result).toBe("cancelled");
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      "engine.mission.outcome_superseded_by_terminal_stop",
      expect.objectContaining({
        runId: "run-1",
        missionId: "mission-1",
        supersededRunStatus: "completed",
      }),
    );
  });

  it("applies the same precedence to a `failed` outcome", async () => {
    mockUpdateStatusIfNotTerminal.mockResolvedValue(false);

    const result = await finalizeMissionRunStatus(
      "mission-1",
      "run-1",
      "session-1",
      "deadline_reached",
    );

    expect(mockUpdateStatus).not.toHaveBeenCalled();
    expect(mockMissionsSetStatus).not.toHaveBeenCalled();
    expect(result).toBe("cancelled");
  });
});

describe("finalizeMissionRunStatus — terminal-stop precedence, system_error", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpdateStatusIfNotTerminal.mockResolvedValue(true);
    mockConsumeAbortIntent.mockReturnValue(null);
    mockIsContinuableRuntimeStop.mockReturnValue(false);
    // `system_error` is handled AFTER the shouldTerminateRun branch.
    mockShouldTerminateRun.mockReturnValue(false);
  });

  it("lands `failed` through the CAS, updates the mission, and emits the bug report", async () => {
    const result = await finalizeMissionRunStatus(
      "mission-1",
      "run-1",
      "session-1",
      "system_error",
      { summary: "boom" },
    );

    expect(result).toBe("failed");
    expect(mockUpdateStatus).not.toHaveBeenCalled();
    const [runId, status, reason] = mockUpdateStatusIfNotTerminal.mock.calls[0]!;
    expect(runId).toBe("run-1");
    expect(status).toBe("failed");
    expect(reason).toBe("system_error");
    expect(mockMissionsSetStatus).toHaveBeenCalledWith("mission-1", "failed");
    expect(mockEmitBugReportSafe).toHaveBeenCalledTimes(1);
  });

  it("does not overwrite a Stop, does not update the mission, and does not file a false bug report", async () => {
    mockUpdateStatusIfNotTerminal.mockResolvedValue(false);

    const result = await finalizeMissionRunStatus(
      "mission-1",
      "run-1",
      "session-1",
      "system_error",
      { summary: "boom" },
    );

    expect(mockUpdateStatus).not.toHaveBeenCalled();
    expect(mockMissionsSetStatus).not.toHaveBeenCalled();
    // A bug report asserting `runtimeStatus: "failed"` would be a false
    // statement about a run that is actually `stopped` / `user_stopped`.
    expect(mockEmitBugReportSafe).not.toHaveBeenCalled();
    expect(result).toBe("cancelled");
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      "engine.mission.outcome_superseded_by_terminal_stop",
      expect.objectContaining({
        runId: "run-1",
        supersededRunStatus: "failed",
        stopReason: "system_error",
      }),
    );
  });
});
