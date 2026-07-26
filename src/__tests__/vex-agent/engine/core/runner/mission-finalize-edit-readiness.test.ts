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
    expect(mockMissionRunsUpdateStatus).toHaveBeenCalledWith(
      "run-1",
      "stopped",
      "user_stopped",
      undefined,
    );
    expect(mockMissionsClearApprovedAt).toHaveBeenCalledWith("mission-1");
    expect(mockMissionsSetStatus).toHaveBeenCalledWith("mission-1", "draft");
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
});
