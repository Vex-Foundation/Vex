/**
 * Mission-finalize - the `tool_call_loop` park arm.
 *
 * Sibling of `mission-finalize-compact-unable.test.ts`, and it exists for the
 * same failure: without a guarded arm, a new stop reason falls through
 * `finalizeMissionRunStatus` to `return "running"` and the run row is left
 * `running` with no wake and no lease - an orphan the operator can neither
 * resume nor see a reason for. A stop reason and a finalize arm land together
 * or the stop reason strands runs.
 *
 * The second thing pinned here is that the park write goes through the
 * terminal-safe CAS with the operator-stop gate in the same transaction. This
 * park reaches `paused_error` with NO wake, so it is the last iteration
 * boundary the run will ever have: an unguarded write would move a run back out
 * of a terminal state, and a `stop_terminal` still queued at this point would
 * be stranded until the operator pressed Stop a second time.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

import { definedValue } from "../../../../_test-value-guards.js";

const mockMissionRunsUpdateStatus = vi.fn();
const mockMissionRunsUpdateStatusIfNotTerminal = vi.fn().mockResolvedValue(true);
const mockMissionsSetStatus = vi.fn();
const mockMissionsClearApprovedAt = vi.fn();
const mockConsumeAbortIntent = vi.fn().mockReturnValue(null);
const mockIsContinuableRuntimeStop = vi.fn().mockReturnValue(false);
const mockGateOnOperatorStop = vi.fn().mockResolvedValue({ kind: "clear" });

vi.mock("@vex-agent/engine/runtime/lease-and-status.js", () => ({
  applyStopForEditTransaction: vi.fn(),
  gateOnOperatorStopWithClient: (...a: unknown[]) => mockGateOnOperatorStop(...a),
  withSessionControlLock: async <T>(
    _sessionId: string,
    fn: (client: unknown) => Promise<T>,
  ): Promise<T> => fn({ client: true }),
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

vi.mock("../../../../../vex-agent/engine/core/runner/abort.js", () => ({
  consumeMissionRunAbortIntent: (...a: unknown[]) => mockConsumeAbortIntent(...a),
}));

vi.mock("../../../../../vex-agent/engine/core/runner/runtime-continuation.js", () => ({
  isContinuableRuntimeStop: (...a: unknown[]) => mockIsContinuableRuntimeStop(...a),
  scheduleRuntimeContinuation: vi.fn(),
}));

import { finalizeMissionRunStatus } from "../../../../../vex-agent/engine/core/runner/mission-finalize.js";

beforeEach(() => {
  vi.clearAllMocks();
  mockIsContinuableRuntimeStop.mockReturnValue(false);
  mockConsumeAbortIntent.mockReturnValue(null);
  mockMissionRunsUpdateStatusIfNotTerminal.mockResolvedValue(true);
  mockGateOnOperatorStop.mockResolvedValue({ kind: "clear" });
});

describe("finalizeMissionRunStatus - tool_call_loop", () => {
  it("parks the run as paused_error with the cause, and never strands it as running", async () => {
    const result = await finalizeMissionRunStatus(
      "mission-1",
      "run-1",
      "session-1",
      "tool_call_loop",
      {
        summary: "repeated swap_quote",
        evidence: { toolName: "swap_quote", cycleLength: 1, repeatCount: 5 },
      },
    );

    // The parent mission row stays `running` so the active-run lookup still
    // surfaces it for /retry, exactly like every other error pause.
    expect(result).toBe("running");
    expect(mockMissionsSetStatus).not.toHaveBeenCalled();

    expect(mockMissionRunsUpdateStatus).not.toHaveBeenCalled();
    expect(mockMissionRunsUpdateStatusIfNotTerminal).toHaveBeenCalledTimes(1);
    const [runId, status, reason, payload] = definedValue(
      mockMissionRunsUpdateStatusIfNotTerminal.mock.calls[0],
      "updateStatusIfNotTerminal first call",
    );
    expect(runId).toBe("run-1");
    expect(status).toBe("paused_error");
    expect(reason).toBe("tool_call_loop");
    expect(payload).toMatchObject({
      summary: "repeated swap_quote",
      evidence: { toolName: "swap_quote", cycleLength: 1, repeatCount: 5 },
    });
  });

  it("falls back to copy that does NOT claim the run was inert", async () => {
    // The repeated calls DID execute, up to the correction. Copy implying an
    // untouched run would be false about a run that may have moved funds on
    // every pass, and it is why this cause is not one-click retryable.
    await finalizeMissionRunStatus("mission-1", "run-1", "session-1", "tool_call_loop");

    const payload = definedValue(
      mockMissionRunsUpdateStatusIfNotTerminal.mock.calls[0],
      "updateStatusIfNotTerminal first call",
    )[3] as { summary: string };
    expect(payload.summary).toContain("did execute");
    expect(payload.summary).toContain("review the transcript");
  });

  it("consumes the operator-stop gate in the same transaction as the park", async () => {
    await finalizeMissionRunStatus("mission-1", "run-1", "session-1", "tool_call_loop");

    expect(mockGateOnOperatorStop).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ sessionId: "session-1", missionRunId: "run-1" }),
    );
  });

  it("writes NOTHING when an operator Stop won the race", async () => {
    mockGateOnOperatorStop.mockResolvedValue({ kind: "stopped", runStatus: "stopped" });

    const result = await finalizeMissionRunStatus(
      "mission-1", "run-1", "session-1", "tool_call_loop",
    );

    expect(mockMissionRunsUpdateStatusIfNotTerminal).not.toHaveBeenCalled();
    expect(result).toBe("running");
  });

  it("does not re-open a run that reached a terminal status first", async () => {
    // A terminal run row is immutable audit history; the CAS refuses and the
    // arm reports what it did to the mission row, which is nothing.
    mockMissionRunsUpdateStatusIfNotTerminal.mockResolvedValue(false);

    const result = await finalizeMissionRunStatus(
      "mission-1", "run-1", "session-1", "tool_call_loop",
    );

    expect(result).toBe("running");
    expect(mockMissionsSetStatus).not.toHaveBeenCalled();
  });
});
