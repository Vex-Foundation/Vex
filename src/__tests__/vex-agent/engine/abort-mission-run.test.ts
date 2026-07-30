/**
 * Operator-driven mission abort — host-only API tests.
 *
 * Covers the cleanup invariant that the plan calls for: after a successful
 * `abortMissionRun(runId)`:
 *   - pending approvals tied to the run's session are rejected,
 *   - pending wakes for the session are cancelled,
 *   - either the in-process AbortSignal is fired (live loop) OR the run is
 *     finalised directly (paused / out-of-process),
 *   - companion guards (`resumeMissionRun` terminal `cancelled`,
 *     `approveAndResume` pre-dispatch) prevent late approvals/resumes from
 *     reviving the cancelled run.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockGetRun = vi.fn();
const mockGetActiveRunBySession = vi.fn();
const mockUpdateRunStatus = vi.fn();
const mockSetMissionStatus = vi.fn();
const mockClearMissionApprovedAt = vi.fn();
const mockCancelForSession = vi.fn();
const mockGetPendingApprovals = vi.fn();
const mockRejectApproval = vi.fn();
const mockReconcileDraftReadiness = vi.fn();
const mockApplyUserStopTransaction = vi.fn();
const mockApplyStopForEditTransaction = vi.fn();

// The direct-finalise branch now runs the SHARED idempotent stop transaction
// (`applyUserStopTransaction`) instead of hand-rolling its own writes, so the
// observer path, the finalize-after-local-abort path and this path can never
// disagree on the terminal state (run `stopped` / `user_stopped`, mission
// `cancelled`). The transaction body itself is covered by
// `runtime/apply-user-stop.test.ts`.
vi.mock("../../../vex-agent/engine/runtime/lease-and-status.js", () => ({
  applyUserStopTransaction: (...a: unknown[]) =>
    mockApplyUserStopTransaction(...a),
  applyStopForEditTransaction: (...a: unknown[]) =>
    mockApplyStopForEditTransaction(...a),
}));

vi.mock("@vex-agent/db/repos/mission-runs.js", () => ({
  getRun: (...a: unknown[]) => mockGetRun(...a),
  getActiveRunBySession: (...a: unknown[]) => mockGetActiveRunBySession(...a),
  updateStatus: (...a: unknown[]) => mockUpdateRunStatus(...a),
}));

vi.mock("@vex-agent/db/repos/missions.js", () => ({
  setStatus: (...a: unknown[]) => mockSetMissionStatus(...a),
  clearApprovedAt: (...a: unknown[]) => mockClearMissionApprovedAt(...a),
}));

vi.mock("@vex-agent/db/repos/loop-wake.js", () => ({
  cancelForSession: (...a: unknown[]) => mockCancelForSession(...a),
}));

vi.mock("@vex-agent/db/repos/approvals.js", () => ({
  getPending: (...a: unknown[]) => mockGetPendingApprovals(...a),
  reject: (...a: unknown[]) => mockRejectApproval(...a),
  approve: vi.fn(),
}));

// WP3 (issue #41): `stopMissionRunForEdit` reconciles draft readiness right
// after it sets the mission back to 'draft' — mocked here so these tests
// control the promoted/not-promoted outcome directly, independent of
// `draft-readiness.test.ts`'s own behavior coverage.
vi.mock("../../../vex-agent/engine/mission/draft-readiness.js", () => ({
  reconcileDraftReadiness: (...a: unknown[]) =>
    mockReconcileDraftReadiness(...a),
}));

const {
  abortMissionRun,
  abortActiveMissionForSession,
  stopActiveMissionForEdit,
  registerMissionRunAbortController,
  unregisterMissionRunAbortController,
  hasMissionRunAbortController,
  signalMissionRunAbortLocal,
} = await import("../../../vex-agent/engine/core/runner/abort.js");

/** Default: the shared stop transaction lands the canonical terminal state. */
function stopApplied(previousStatus: string) {
  return {
    outcome: "stopped",
    previousStatus,
    missionId: "mission-x",
    rejectedApprovals: 0,
    wakeCancelledCount: 0,
    consumedRequests: 0,
  };
}

/** Default for the stop-for-edit path: this call won the run transition. */
function editApplied(previousStatus: string, rejectedApprovals = 0) {
  return {
    outcome: "stopped_for_edit",
    previousStatus,
    missionId: "mission-edit",
    rejectedApprovals,
  };
}

describe("abortMissionRun", () => {
  beforeEach(() => {
    mockGetRun.mockReset();
    mockGetActiveRunBySession.mockReset();
    mockUpdateRunStatus.mockReset();
    mockSetMissionStatus.mockReset();
    mockClearMissionApprovedAt.mockReset();
    mockCancelForSession.mockReset();
    mockGetPendingApprovals.mockReset();
    mockRejectApproval.mockReset();
    mockCancelForSession.mockResolvedValue(0);
    mockGetPendingApprovals.mockResolvedValue([]);
    mockApplyUserStopTransaction.mockReset();
    mockApplyUserStopTransaction.mockResolvedValue(stopApplied("paused_approval"));
    mockApplyStopForEditTransaction.mockReset();
    // Drop any controllers leaked between tests.
    if (hasMissionRunAbortController("run-1")) unregisterMissionRunAbortController("run-1");
    if (hasMissionRunAbortController("run-running")) unregisterMissionRunAbortController("run-running");
    if (hasMissionRunAbortController("run-edit")) unregisterMissionRunAbortController("run-edit");
  });

  it("paused_approval with 2 pending approvals → cancelled, rejectedApprovals=2", async () => {
    mockGetRun.mockResolvedValue({
      id: "run-1",
      missionId: "mission-1",
      sessionId: "sess-1",
      status: "paused_approval",
    });
    mockGetPendingApprovals.mockResolvedValue([
      { id: "ap-1", sessionId: "sess-1" },
      { id: "ap-2", sessionId: "sess-1" },
      { id: "ap-3", sessionId: "other-session" }, // must be ignored
    ]);
    mockRejectApproval.mockResolvedValue({ id: "ap-1", status: "rejected" });

    const result = await abortMissionRun("run-1");

    expect(result.aborted).toBe(true);
    expect(result.finalStatus).toBe("cancelled");
    expect(result.rejectedApprovals).toBe(2);
    expect(mockRejectApproval).toHaveBeenCalledTimes(2);
    expect(mockRejectApproval).toHaveBeenCalledWith("ap-1");
    expect(mockRejectApproval).toHaveBeenCalledWith("ap-2");
    expect(mockRejectApproval).not.toHaveBeenCalledWith("ap-3");
    // Terminal state is written by the SHARED stop transaction, not by
    // hand-rolled writes here — that is what keeps this path and the loop's
    // own finalize byte-identical.
    expect(mockApplyUserStopTransaction).toHaveBeenCalledWith({
      sessionId: "sess-1",
      missionRunId: "run-1",
    });
    expect(mockUpdateRunStatus).not.toHaveBeenCalled();
    expect(mockSetMissionStatus).not.toHaveBeenCalled();
  });

  it("running with registered controller → fires AbortSignal, status stays running", async () => {
    mockGetRun.mockResolvedValue({
      id: "run-running",
      missionId: "mission-2",
      sessionId: "sess-2",
      status: "running",
    });
    const controller = registerMissionRunAbortController("run-running");

    const result = await abortMissionRun("run-running");

    expect(controller.signal.aborted).toBe(true);
    expect(result.aborted).toBe(true);
    expect(result.finalStatus).toBe("running"); // loop will finalise async
    expect(result.rejectedApprovals).toBe(0);
    // Direct finalize path NOT taken — loop owns that.
    expect(mockUpdateRunStatus).not.toHaveBeenCalled();
    expect(mockSetMissionStatus).not.toHaveBeenCalled();
  });

  it("running without registered controller → finalises directly", async () => {
    mockGetRun.mockResolvedValue({
      id: "run-orphan",
      missionId: "mission-3",
      sessionId: "sess-3",
      status: "running",
    });

    const result = await abortMissionRun("run-orphan");

    expect(result.aborted).toBe(true);
    expect(result.finalStatus).toBe("cancelled");
    expect(mockApplyUserStopTransaction).toHaveBeenCalledWith({
      sessionId: "sess-3",
      missionRunId: "run-orphan",
    });
  });

  it("raced to terminal between read and lock → aborted:false, no double write", async () => {
    mockGetRun.mockResolvedValue({
      id: "run-race",
      missionId: "mission-race",
      sessionId: "sess-race",
      status: "paused_wake",
    });
    mockApplyUserStopTransaction.mockResolvedValue({
      outcome: "already_terminal",
      currentStatus: "stopped",
      consumedRequests: 0,
    });

    const result = await abortMissionRun("run-race");

    expect(result.aborted).toBe(false);
    expect(mockUpdateRunStatus).not.toHaveBeenCalled();
  });

  it("paused_wake → cancels wakes + finalises directly", async () => {
    mockGetRun.mockResolvedValue({
      id: "run-w",
      missionId: "mission-w",
      sessionId: "sess-w",
      status: "paused_wake",
    });

    const result = await abortMissionRun("run-w");

    expect(result.aborted).toBe(true);
    expect(result.finalStatus).toBe("cancelled");
    expect(mockCancelForSession).toHaveBeenCalledWith("sess-w", "user_aborted");
  });

  for (const terminal of ["completed", "failed", "stopped", "cancelled"]) {
    it(`${terminal} → no-op`, async () => {
      mockGetRun.mockResolvedValue({
        id: "run-t",
        missionId: "mission-t",
        sessionId: "sess-t",
        status: terminal,
      });

      const result = await abortMissionRun("run-t");

      expect(result.aborted).toBe(false);
      expect(result.finalStatus).toBe(terminal);
      expect(result.rejectedApprovals).toBe(0);
      expect(mockUpdateRunStatus).not.toHaveBeenCalled();
      expect(mockSetMissionStatus).not.toHaveBeenCalled();
      expect(mockCancelForSession).not.toHaveBeenCalled();
    });
  }

  it("missing run → throws", async () => {
    mockGetRun.mockResolvedValue(null);
    await expect(abortMissionRun("missing")).rejects.toThrow(/not found/);
  });
});

describe("stopActiveMissionForEdit", () => {
  beforeEach(() => {
    mockGetRun.mockReset();
    mockGetActiveRunBySession.mockReset();
    mockUpdateRunStatus.mockReset();
    mockSetMissionStatus.mockReset();
    mockClearMissionApprovedAt.mockReset();
    mockCancelForSession.mockReset();
    mockGetPendingApprovals.mockReset();
    mockRejectApproval.mockReset();
    mockReconcileDraftReadiness.mockReset();
    mockCancelForSession.mockResolvedValue(0);
    mockGetPendingApprovals.mockResolvedValue([]);
    // Default: not promoted. Individual tests override to cover both
    // branches of the WP3 reconciliation outcome.
    mockReconcileDraftReadiness.mockResolvedValue({ promoted: false });
    mockApplyStopForEditTransaction.mockReset();
    mockApplyStopForEditTransaction.mockResolvedValue(editApplied("paused_wake"));
    if (hasMissionRunAbortController("run-edit")) unregisterMissionRunAbortController("run-edit");
  });

  // WP3 (issue #41): `finalStatus` used to hard-code "draft" regardless of
  // whether the stopped-for-edit mission was actually complete — that's the
  // bug (drafts trapped in "Preparing"). It now reflects
  // `reconcileDraftReadiness`'s outcome. Two deliberate variants replace the
  // single always-"draft" assertion this test used to make.
  it("stops an active run for editing and promotes a complete draft to ready", async () => {
    mockGetActiveRunBySession.mockResolvedValue({ id: "run-edit" });
    mockGetRun.mockResolvedValue({
      id: "run-edit",
      missionId: "mission-edit",
      sessionId: "sess-edit",
      status: "paused_wake",
    });
    mockReconcileDraftReadiness.mockResolvedValue({ promoted: true });

    const result = await stopActiveMissionForEdit("sess-edit");

    expect(result?.stopped).toBe(true);
    expect(result?.finalStatus).toBe("ready");
    expect(mockCancelForSession).toHaveBeenCalledWith("sess-edit", "user_edit");
    // The run row + mission demotion are now ONE atomic, lock-aware
    // transition; this module no longer hand-rolls either write, which is what
    // made the unlocked read-then-write race possible.
    expect(mockApplyStopForEditTransaction).toHaveBeenCalledWith({
      sessionId: "sess-edit",
      missionRunId: "run-edit",
    });
    expect(mockUpdateRunStatus).not.toHaveBeenCalled();
    expect(mockClearMissionApprovedAt).not.toHaveBeenCalled();
    expect(mockSetMissionStatus).not.toHaveBeenCalled();
    expect(mockReconcileDraftReadiness).toHaveBeenCalledWith("mission-edit");
  });

  it("stops an active run for editing and leaves an incomplete draft as draft", async () => {
    mockGetActiveRunBySession.mockResolvedValue({ id: "run-edit" });
    mockGetRun.mockResolvedValue({
      id: "run-edit",
      missionId: "mission-edit",
      sessionId: "sess-edit",
      status: "paused_wake",
    });
    mockReconcileDraftReadiness.mockResolvedValue({ promoted: false });

    const result = await stopActiveMissionForEdit("sess-edit");

    expect(result?.stopped).toBe(true);
    expect(result?.finalStatus).toBe("draft");
    expect(mockReconcileDraftReadiness).toHaveBeenCalledWith("mission-edit");
  });

  it("signals a live running loop before returning the mission to draft", async () => {
    mockGetActiveRunBySession.mockResolvedValue({ id: "run-edit" });
    mockGetRun.mockResolvedValue({
      id: "run-edit",
      missionId: "mission-edit",
      sessionId: "sess-edit",
      status: "running",
    });
    mockApplyStopForEditTransaction.mockResolvedValue(editApplied("running"));
    const controller = registerMissionRunAbortController("run-edit");

    const result = await stopActiveMissionForEdit("sess-edit");

    expect(result?.stopped).toBe(true);
    expect(result?.finalStatus).toBe("draft");
    expect(controller.signal.aborted).toBe(true);
  });

  // OWNER DECISION: a committed user Stop is FINAL. These two cases are the
  // whole point of routing through the atomic transition — before it, the
  // module read the run outside a transaction and then wrote unconditionally,
  // so an ordinary Stop committing in that gap was overwritten and its
  // `cancelled` mission was resurrected as `draft`.
  it("does NOT report a successful edit when an ordinary Stop won the transition", async () => {
    mockGetActiveRunBySession.mockResolvedValue({ id: "run-edit" });
    mockGetRun.mockResolvedValue({
      id: "run-edit",
      missionId: "mission-edit",
      sessionId: "sess-edit",
      status: "running",
    });
    mockApplyStopForEditTransaction.mockResolvedValue({
      outcome: "lost_to_terminal",
      missionId: "mission-edit",
      currentRunStatus: "stopped",
      missionStatus: "cancelled",
    });

    const result = await stopActiveMissionForEdit("sess-edit");

    // The caller learns it lost, so `mission.edit` IPC reports
    // `already_terminal` instead of a successful edit.
    expect(result?.stopped).toBe(false);
    // The mission stays cancelled — NOT demoted to draft.
    expect(result?.finalStatus).toBe("cancelled");
    expect(mockUpdateRunStatus).not.toHaveBeenCalled();
    expect(mockSetMissionStatus).not.toHaveBeenCalled();
    expect(mockClearMissionApprovedAt).not.toHaveBeenCalled();
    // A lost edit must not reconcile draft readiness either — that would
    // promote a mission the user never put back into drafting.
    expect(mockReconcileDraftReadiness).not.toHaveBeenCalled();
  });

  it("reports a successful edit when the sibling finalize path landed it first", async () => {
    mockGetActiveRunBySession.mockResolvedValue({ id: "run-edit" });
    mockGetRun.mockResolvedValue({
      id: "run-edit",
      missionId: "mission-edit",
      sessionId: "sess-edit",
      status: "running",
    });
    mockApplyStopForEditTransaction.mockResolvedValue({
      outcome: "already_edited",
      missionId: "mission-edit",
      missionStatus: "draft",
    });

    const result = await stopActiveMissionForEdit("sess-edit");

    expect(result?.stopped).toBe(true);
    expect(result?.finalStatus).toBe("draft");
    expect(mockUpdateRunStatus).not.toHaveBeenCalled();
  });
});

describe("abortActiveMissionForSession", () => {
  beforeEach(() => {
    mockGetRun.mockReset();
    mockGetActiveRunBySession.mockReset();
    mockUpdateRunStatus.mockReset();
    mockSetMissionStatus.mockReset();
    mockClearMissionApprovedAt.mockReset();
    mockCancelForSession.mockReset();
    mockGetPendingApprovals.mockReset();
    mockRejectApproval.mockReset();
    mockCancelForSession.mockResolvedValue(0);
    mockGetPendingApprovals.mockResolvedValue([]);
    mockApplyUserStopTransaction.mockReset();
    mockApplyUserStopTransaction.mockResolvedValue(stopApplied("paused_approval"));
  });

  it("returns null when session has no active run", async () => {
    mockGetActiveRunBySession.mockResolvedValue(null);
    const result = await abortActiveMissionForSession("sess-empty");
    expect(result).toBeNull();
  });

  it("delegates to abortMissionRun when active run exists", async () => {
    mockGetActiveRunBySession.mockResolvedValue({ id: "run-active" });
    mockGetRun.mockResolvedValue({
      id: "run-active",
      missionId: "m",
      sessionId: "sess",
      status: "paused_approval",
    });

    const result = await abortActiveMissionForSession("sess");
    expect(result?.aborted).toBe(true);
    expect(result?.finalStatus).toBe("cancelled");
  });
});

// ── Local abort signal (IPC stop fast path) ─────────────────────

describe("signalMissionRunAbortLocal", () => {
  beforeEach(() => {
    mockUpdateRunStatus.mockReset();
    mockSetMissionStatus.mockReset();
    mockApplyUserStopTransaction.mockReset();
  });

  it("fires the registered controller and writes nothing", async () => {
    const controller = registerMissionRunAbortController("run-local");
    try {
      const fired = signalMissionRunAbortLocal("run-local");
      expect(fired).toBe(true);
      expect(controller.signal.aborted).toBe(true);
      // Write-free by contract: the durable control request is the caller's
      // responsibility and is persisted BEFORE this is called.
      expect(mockUpdateRunStatus).not.toHaveBeenCalled();
      expect(mockSetMissionStatus).not.toHaveBeenCalled();
      expect(mockApplyUserStopTransaction).not.toHaveBeenCalled();
    } finally {
      unregisterMissionRunAbortController("run-local");
    }
  });

  it("returns false when no controller is registered in this process", () => {
    expect(hasMissionRunAbortController("run-elsewhere")).toBe(false);
    expect(signalMissionRunAbortLocal("run-elsewhere")).toBe(false);
  });
});

// ── Companion guards ────────────────────────────────────────────

describe("companion guards", () => {
  it("MissionRunStatus union includes cancelled (compile-time)", () => {
    const status: import("../../../vex-agent/engine/types.js").MissionRunStatus = "cancelled";
    expect(status).toBe("cancelled");
  });
});
