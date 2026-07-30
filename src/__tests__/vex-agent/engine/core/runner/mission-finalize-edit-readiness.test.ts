/**
 * Mission-finalize regression — the async edit finalizer's returned status
 * (BLOCKER 2, fix-wave prs-17-07-2026).
 *
 * `finalizeMissionRunStatus`'s `user_stopped` + edit-abort-intent branch
 * awaits `reconcileDraftReadiness(missionId)` and previously IGNORED its
 * `{ promoted }` result, always returning the hard-coded `"draft"`. That
 * return value becomes the observable `TurnResult.missionStatus`
 * (`mission-run.ts`), so a mission that was actually complete when the
 * operator stopped-for-edit was reported back as "draft" instead of
 * "ready" — mirrors the fix already applied to the SYNC path in
 * `abort.ts`'s `stopActiveMissionForEdit` (see `abort-mission-run.test.ts`).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockMissionRunsUpdateStatus = vi.fn();
const mockMissionRunsGetRun = vi.fn();
const mockMissionsSetStatus = vi.fn();
const mockMissionsClearApprovedAt = vi.fn();
const mockConsumeAbortIntent = vi.fn();
const mockScheduleRuntimeContinuation = vi.fn();
const mockIsContinuableRuntimeStop = vi.fn().mockReturnValue(false);
const mockReconcileDraftReadiness = vi.fn();

const mockApplyStopForEditTransaction = vi.fn();
// `mission-finalize.ts` now reaches the runtime control plane for two things:
// the ONE atomic stop-for-edit transition, and the durable operator-Stop
// consumer that guards the `compact_unable_at_critical` park. Both are stubbed
// to "no stop raced us" here; their own behaviour is covered by
// `runtime/apply-user-stop.test.ts`, the stop-for-edit integration file and
// `runner/paused-error-stop-consumer.test.ts`.
vi.mock("@vex-agent/engine/runtime/lease-and-status.js", () => ({
  applyStopForEditTransaction: (...a: unknown[]) =>
    mockApplyStopForEditTransaction(...a),
  gateOnOperatorStopWithClient: async () => ({ kind: "clear" }),
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
  // emitFinalizeControlState re-reads the run for the post-finalize broadcast;
  // returning null makes it a safe, deterministic no-op for this test's scope.
  getRun: (...a: unknown[]) => mockMissionRunsGetRun(...a),
}));

vi.mock("../../../../../vex-agent/engine/core/runner/abort.js", () => ({
  consumeMissionRunAbortIntent: (...a: unknown[]) => mockConsumeAbortIntent(...a),
}));

vi.mock("../../../../../vex-agent/engine/core/runner/runtime-continuation.js", () => ({
  isContinuableRuntimeStop: (...a: unknown[]) => mockIsContinuableRuntimeStop(...a),
  scheduleRuntimeContinuation: (...a: unknown[]) =>
    mockScheduleRuntimeContinuation(...a),
}));

// WP3 (issue #41) idiom — same reconcile-mock as abort-mission-run.test.ts:
// mocked so this test controls the promoted/not-promoted outcome directly,
// independent of `draft-readiness.test.ts`'s own behavior coverage.
vi.mock("@vex-agent/engine/mission/draft-readiness.js", () => ({
  reconcileDraftReadiness: (...a: unknown[]) => mockReconcileDraftReadiness(...a),
}));

import { finalizeMissionRunStatus } from "../../../../../vex-agent/engine/core/runner/mission-finalize.js";

describe("finalizeMissionRunStatus — user_stopped edit-abort-intent branch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsContinuableRuntimeStop.mockReturnValue(false);
    mockConsumeAbortIntent.mockReturnValue("edit");
    mockMissionRunsGetRun.mockResolvedValue(null);
    // Default: this finalizer won the run transition, so the mission demotion
    // happened inside the shared transaction.
    mockApplyStopForEditTransaction.mockResolvedValue({
      outcome: "stopped_for_edit",
      previousStatus: "running",
      missionId: "mission-1",
      rejectedApprovals: 0,
    });
  });

  it('returns "ready" when reconcileDraftReadiness resolves { promoted: true }', async () => {
    mockReconcileDraftReadiness.mockResolvedValue({ promoted: true });

    const result = await finalizeMissionRunStatus(
      "mission-1",
      "run-1",
      "session-1",
      "user_stopped",
    );

    expect(result).toBe("ready");
    expect(mockReconcileDraftReadiness).toHaveBeenCalledWith("mission-1");
    // The run row and the mission demotion are now ONE atomic transition, and
    // this module no longer writes either directly — that unlocked
    // read-then-write is exactly what let an ordinary Stop be clobbered.
    expect(mockApplyStopForEditTransaction).toHaveBeenCalledWith({
      sessionId: "session-1",
      missionRunId: "run-1",
    });
    expect(mockMissionRunsUpdateStatus).not.toHaveBeenCalled();
    expect(mockMissionsClearApprovedAt).not.toHaveBeenCalled();
    expect(mockMissionsSetStatus).not.toHaveBeenCalled();
  });

  it('returns "draft" when reconcileDraftReadiness resolves { promoted: false }', async () => {
    mockReconcileDraftReadiness.mockResolvedValue({ promoted: false });

    const result = await finalizeMissionRunStatus(
      "mission-1",
      "run-1",
      "session-1",
      "user_stopped",
    );

    expect(result).toBe("draft");
    expect(mockReconcileDraftReadiness).toHaveBeenCalledWith("mission-1");
  });

  // OWNER DECISION: a committed user Stop is FINAL. The async edit finalizer
  // used to repeat the same unlocked write + demotion `abort.ts` did, so an
  // ordinary Stop that committed while the loop unwound was overwritten and
  // its `cancelled` mission was resurrected as `draft`.
  it("does NOT demote the mission when an ordinary Stop won the transition", async () => {
    mockApplyStopForEditTransaction.mockResolvedValue({
      outcome: "lost_to_terminal",
      missionId: "mission-1",
      currentRunStatus: "stopped",
      missionStatus: "cancelled",
    });

    const result = await finalizeMissionRunStatus(
      "mission-1",
      "run-1",
      "session-1",
      "user_stopped",
    );

    // Reports the mission row's REAL status, not a successful edit.
    expect(result).toBe("cancelled");
    expect(mockMissionRunsUpdateStatus).not.toHaveBeenCalled();
    expect(mockMissionsSetStatus).not.toHaveBeenCalled();
    expect(mockMissionsClearApprovedAt).not.toHaveBeenCalled();
    expect(mockReconcileDraftReadiness).not.toHaveBeenCalled();
  });

  it("reports the edit when the sibling abort.ts transaction landed it first", async () => {
    mockApplyStopForEditTransaction.mockResolvedValue({
      outcome: "already_edited",
      missionId: "mission-1",
      missionStatus: "ready",
    });

    const result = await finalizeMissionRunStatus(
      "mission-1",
      "run-1",
      "session-1",
      "user_stopped",
    );

    expect(result).toBe("ready");
    expect(mockReconcileDraftReadiness).not.toHaveBeenCalled();
  });
});
