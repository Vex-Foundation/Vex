/**
 * runResumeDispatch — dead-lease reclaim (WP-C, issue #12's bug class).
 *
 * `status === 'running'` alone does NOT mean a runner is observing the
 * session: the lease can be expired/released. A LIVE lease still reports
 * `already_running` (unchanged); a DEAD lease now falls through to the same
 * claim/resume path as `paused_user` / `paused_wake` instead of lying that
 * the run is already going.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGetActiveRun = vi.fn();
const mockEnsureDbUrl = vi.fn();
const mockEmitControlState = vi.fn();
const mockEnqueueRequest = vi.fn();
const mockMarkObserved = vi.fn();
const mockMarkCleared = vi.fn();
const mockMarkFailed = vi.fn();
const mockClaim = vi.fn();
const mockCreateLeaseHandle = vi.fn();
const mockResumeMissionRun = vi.fn();
const mockRelease = vi.fn();

vi.mock("../../database/mission-runs-db.js", () => ({
  getActiveRunForSession: (...a: unknown[]) => mockGetActiveRun(...a),
}));
vi.mock("../runtime/_ensure-engine-db-url.js", () => ({
  ensureEngineDbUrl: (...a: unknown[]) => mockEnsureDbUrl(...a),
}));
vi.mock("../runtime/_emit-control-state.js", () => ({
  emitControlStateAfterChange: (...a: unknown[]) => mockEmitControlState(...a),
}));
vi.mock("../runtime/_errors.js", () => ({
  controlFailedError: () => ({ code: "control_failed", redacted: true }),
}));
vi.mock("../../logger/index.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("@vex-agent/db/repos/runtime-control-requests.js", () => ({
  enqueueRequest: (...a: unknown[]) => mockEnqueueRequest(...a),
  markObserved: (...a: unknown[]) => mockMarkObserved(...a),
  markCleared: (...a: unknown[]) => mockMarkCleared(...a),
  markFailed: (...a: unknown[]) => mockMarkFailed(...a),
}));
vi.mock("@vex-agent/engine/runtime/lease-and-status.js", () => ({
  claimRunLeaseAndFlipToRunning: (...a: unknown[]) => mockClaim(...a),
}));
vi.mock("@vex-agent/engine/runtime/lease-handle.js", () => ({
  createLeaseHandle: (...a: unknown[]) => mockCreateLeaseHandle(...a),
}));
vi.mock("@vex-agent/engine/index.js", () => ({
  resumeMissionRun: (...a: unknown[]) => mockResumeMissionRun(...a),
}));
vi.mock("@vex-agent/engine/runtime/release-and-emit.js", () => ({
  releaseLeaseAndEmitControlState: (...a: unknown[]) => mockRelease(...a),
}));

const { runResumeDispatch } = await import(
  "../_shared/runtime-resume-dispatch.js"
);

const CTX = { requestId: "req-1", channelLabel: "test" };
const SESSION = "s1";

function activeState(status: string, leaseActive: boolean) {
  return {
    ok: true,
    data: {
      hasActiveRun: true,
      missionRunId: "run-1",
      status,
      leaseActive,
      stopReason: null,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockEnsureDbUrl.mockResolvedValue({ ok: true, data: undefined });
  mockEmitControlState.mockResolvedValue(undefined);
});

describe("runResumeDispatch — running status + lease liveness", () => {
  it("reports already_running for a running run with a LIVE lease (unchanged)", async () => {
    mockGetActiveRun.mockResolvedValue(activeState("running", true));

    const result = await runResumeDispatch({ sessionId: SESSION }, CTX);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.data.outcome).toBe("already_running");
    expect(mockClaim).not.toHaveBeenCalled();
  });

  it("attempts to RECLAIM (fromStatuses=['running']) instead of already_running when the lease is DEAD", async () => {
    mockGetActiveRun.mockResolvedValue(activeState("running", false));
    mockEnqueueRequest.mockResolvedValue({ id: "audit-1" });
    mockClaim.mockResolvedValue({
      outcome: "claimed",
      lease: { ownerId: "owner-x" },
      previousStatus: "running",
      wakeCancelledCount: 0,
    });
    mockCreateLeaseHandle.mockReturnValue({});
    mockResumeMissionRun.mockResolvedValue({ text: "ok" });
    mockRelease.mockResolvedValue(undefined);

    const result = await runResumeDispatch({ sessionId: SESSION }, CTX);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.data.outcome).toBe("resumed");
    expect(mockClaim).toHaveBeenCalledWith(
      expect.objectContaining({ fromStatuses: ["running"], missionRunId: "run-1" }),
    );
    await vi.waitFor(() =>
      expect(mockResumeMissionRun).toHaveBeenCalledWith("run-1", "owner-x"),
    );
  });

  it("returns lease_busy — does not lie — when a live runner reclaims the dead lease first (race)", async () => {
    mockGetActiveRun.mockResolvedValue(activeState("running", false));
    mockEnqueueRequest.mockResolvedValue({ id: "audit-1" });
    mockClaim.mockResolvedValue({
      outcome: "lease_busy",
      currentLease: { expiresAt: new Date(Date.now() + 30_000) },
    });

    const result = await runResumeDispatch({ sessionId: SESSION }, CTX);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.data.outcome).toBe("lease_busy");
    expect(mockResumeMissionRun).not.toHaveBeenCalled();
  });

  it("returns blocked_error status_changed when the run's status changed between the read and the claim (race)", async () => {
    mockGetActiveRun.mockResolvedValue(activeState("running", false));
    mockEnqueueRequest.mockResolvedValue({ id: "audit-1" });
    mockClaim.mockResolvedValue({ outcome: "status_mismatch", currentStatus: "completed" });

    const result = await runResumeDispatch({ sessionId: SESSION }, CTX);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.data.outcome).toBe("blocked_error");
    expect(mockResumeMissionRun).not.toHaveBeenCalled();
  });
});
