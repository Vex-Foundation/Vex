/**
 * /retry — retryActiveMissionRun.
 *
 * Puzzle 3 collapsed the previous non-atomic "cancelForSession then
 * casFlipToRunning" pair into a single `claimRunLeaseAndFlipToRunning`
 * transaction. These tests assert the atomic helper contract and the
 * four refusal paths. The atomic helper internally cancels pending
 * wakes only when the observed `previousStatus === "paused_wake"`; for
 * `paused_error` no wake cleanup is needed.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockGetActiveRunBySession = vi.fn();
const mockClaimRunLeaseAndFlipToRunning = vi.fn();
const mockResumeMissionRun = vi.fn();
const mockReleaseLease = vi.fn().mockResolvedValue(undefined);
const mockCancelForSession = vi.fn().mockResolvedValue(0);

vi.mock("@vex-agent/db/repos/mission-runs.js", () => ({
  getActiveRunBySession: (...a: unknown[]) => mockGetActiveRunBySession(...a),
}));

// Phase 4d: retryActiveMissionRun cancels pending error_retry wakes first.
vi.mock("@vex-agent/db/repos/loop-wake.js", () => ({
  cancelForSession: (...a: unknown[]) => mockCancelForSession(...a),
}));

vi.mock("@vex-agent/engine/runtime/lease-and-status.js", () => ({
  claimRunLeaseAndFlipToRunning: (...a: unknown[]) => mockClaimRunLeaseAndFlipToRunning(...a),
  claimSessionLease: vi.fn(),
  observeAndApplyControl: vi.fn().mockResolvedValue({ outcome: "no_request" }),
}));

vi.mock("@vex-agent/engine/runtime/lease-handle.js", () => ({
  createLeaseHandle: vi.fn().mockReturnValue({
    lease: {
      sessionId: "s-1", missionRunId: "run-1", ownerId: "test-owner",
      processKind: "electron_main",
      acquiredAt: new Date(), heartbeatAt: new Date(), expiresAt: new Date(),
    },
    ownerId: "test-owner",
    release: vi.fn().mockResolvedValue(undefined),
    onLeaseLost: vi.fn(),
  }),
}));

vi.mock("@vex-agent/engine/runtime/release-and-emit.js", () => ({
  releaseLeaseAndEmitControlState: (...a: unknown[]) => mockReleaseLease(...a),
}));

vi.mock("../../../../../vex-agent/engine/core/runner/mission.js", () => ({
  resumeMissionRun: (...a: unknown[]) => mockResumeMissionRun(...a),
}));

const { retryActiveMissionRun } = await import(
  "../../../../../vex-agent/engine/core/runner/retry.js"
);

const okTurnResult = {
  text: "resumed",
  toolCallsMade: 0,
  pendingApprovals: [],
  stopReason: null,
  missionStatus: "running" as const,
};

function stubLease(missionRunId = "run-1") {
  return {
    sessionId: "s-1",
    missionRunId,
    ownerId: "test-owner",
    processKind: "electron_main" as const,
    acquiredAt: new Date(),
    heartbeatAt: new Date(),
    expiresAt: new Date(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default claim outcome — `claimed` with `previousStatus=paused_error`.
  // Tests covering paused_wake / lease_busy / status_mismatch override
  // per-suite via `mockResolvedValueOnce`.
  mockClaimRunLeaseAndFlipToRunning.mockResolvedValue({
    outcome: "claimed",
    previousStatus: "paused_error",
    lease: stubLease(),
    wakeCancelledCount: 0,
  });
  mockResumeMissionRun.mockResolvedValue(okTurnResult);
  mockReleaseLease.mockResolvedValue(undefined);
});

function activeRun(status: string) {
  return { id: "run-1", missionId: "m-1", sessionId: "s-1", status };
}

describe("retryActiveMissionRun", () => {
  it("rejects with hint when there is no active run", async () => {
    mockGetActiveRunBySession.mockResolvedValue(null);
    await expect(retryActiveMissionRun("s-1")).rejects.toThrow(/No active mission run to retry/);
  });

  it("rejects from paused_approval with the approve/reject hint", async () => {
    mockGetActiveRunBySession.mockResolvedValue(activeRun("paused_approval"));
    await expect(retryActiveMissionRun("s-1")).rejects.toThrow(/awaiting approval/);
    expect(mockClaimRunLeaseAndFlipToRunning).not.toHaveBeenCalled();
  });

  it("rejects from running with 'already in progress'", async () => {
    mockGetActiveRunBySession.mockResolvedValue(activeRun("running"));
    await expect(retryActiveMissionRun("s-1")).rejects.toThrow(/already in progress/);
    expect(mockClaimRunLeaseAndFlipToRunning).not.toHaveBeenCalled();
  });

  it.each([["completed"], ["failed"], ["stopped"], ["cancelled"]] as const)(
    "rejects from terminal status %s",
    async (status) => {
      mockGetActiveRunBySession.mockResolvedValue(activeRun(status));
      await expect(retryActiveMissionRun("s-1")).rejects.toThrow(/cannot be retried/);
      expect(mockClaimRunLeaseAndFlipToRunning).not.toHaveBeenCalled();
    },
  );

  it("calls the atomic claim helper with both retryable from-statuses", async () => {
    mockGetActiveRunBySession.mockResolvedValue(activeRun("paused_error"));
    await retryActiveMissionRun("s-1");
    expect(mockClaimRunLeaseAndFlipToRunning).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "s-1",
        missionRunId: "run-1",
        fromStatuses: ["paused_error", "paused_wake"],
      }),
    );
  });

  it("flips paused_error → running and resumes the run", async () => {
    mockGetActiveRunBySession.mockResolvedValue(activeRun("paused_error"));
    const result = await retryActiveMissionRun("s-1");
    expect(mockResumeMissionRun).toHaveBeenCalledWith("run-1", "retry-run-1");
    expect(result).toEqual(okTurnResult);
    // Phase 4d: a human Recover cancels any pending error_retry wake first.
    expect(mockCancelForSession).toHaveBeenCalledWith(
      "s-1",
      "superseded_by_manual_recover",
    );
  });

  it("flips paused_wake → running and resumes the run", async () => {
    mockGetActiveRunBySession.mockResolvedValue(activeRun("paused_wake"));
    // Atomic helper cancels pending wakes internally only when previousStatus
    // === "paused_wake" — that internal contract is owned by claim-run-lease,
    // not by retry. Test asserts the visible outcome (resume entered loop).
    mockClaimRunLeaseAndFlipToRunning.mockResolvedValueOnce({
      outcome: "claimed",
      previousStatus: "paused_wake",
      lease: stubLease(),
      wakeCancelledCount: 1,
    });
    const result = await retryActiveMissionRun("s-1");
    expect(mockResumeMissionRun).toHaveBeenCalledWith("run-1", "retry-run-1");
    expect(result).toEqual(okTurnResult);
  });

  it("refuses cleanly when the claim loses on status_mismatch", async () => {
    mockGetActiveRunBySession.mockResolvedValue(activeRun("paused_wake"));
    mockClaimRunLeaseAndFlipToRunning.mockResolvedValueOnce({
      outcome: "status_mismatch",
      currentStatus: "running",
    });
    await expect(retryActiveMissionRun("s-1")).rejects.toThrow(/claimed by another resumer/);
    expect(mockResumeMissionRun).not.toHaveBeenCalled();
  });

  it("refuses cleanly when the lease is busy", async () => {
    mockGetActiveRunBySession.mockResolvedValue(activeRun("paused_wake"));
    mockClaimRunLeaseAndFlipToRunning.mockResolvedValueOnce({
      outcome: "lease_busy",
      currentLease: stubLease(),
    });
    await expect(retryActiveMissionRun("s-1")).rejects.toThrow(/lease was claimed by another runner/);
    expect(mockResumeMissionRun).not.toHaveBeenCalled();
  });
});
