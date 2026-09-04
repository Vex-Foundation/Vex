/**
 * runResumeDispatch — plan-acceptance gate (Codex final-review blockers).
 *
 * Resume of a `paused_plan_acceptance` run is gated on plan ACCEPTANCE, not on
 * the caller: refuse while the plan is unaccepted (renderer is untrusted), but
 * allow once accepted — so an accepted-but-still-paused run is recoverable via
 * ANY resume path. These tests assert both arms and that the refusal
 * short-circuits BEFORE the claim machinery.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGetActiveRun = vi.fn();
const mockGetActivePlan = vi.fn();
const mockEnsureDbUrl = vi.fn();
const mockEmitControlState = vi.fn();
const mockEnqueueRequest = vi.fn();
const mockMarkFailed = vi.fn();
const mockClaim = vi.fn();

vi.mock("../../database/mission-runs-db.js", () => ({
  getActiveRunForSession: (...a: unknown[]) => mockGetActiveRun(...a),
}));
vi.mock("@vex-agent/db/repos/session-plans.js", () => ({
  getActivePlan: (...a: unknown[]) => mockGetActivePlan(...a),
}));
vi.mock("../../database/engine-db-readiness.js", () => ({
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
  markObserved: vi.fn(),
  markCleared: vi.fn(),
  markFailed: (...a: unknown[]) => mockMarkFailed(...a),
}));
vi.mock("@vex-agent/engine/runtime/lease-and-status.js", () => ({
  claimRunLeaseAndFlipToRunning: (...a: unknown[]) => mockClaim(...a),
}));

const { runResumeDispatch } = await import("../_shared/runtime-resume-dispatch.js");

const CTX = { requestId: "req-1", channelLabel: "test" };

beforeEach(() => {
  vi.clearAllMocks();
  mockEnsureDbUrl.mockResolvedValue({ ok: true, data: undefined });
  mockGetActiveRun.mockResolvedValue({
    ok: true,
    data: { hasActiveRun: true, missionRunId: "run-1", status: "paused_plan_acceptance", stopReason: null },
  });
  mockEmitControlState.mockResolvedValue(undefined);
});

describe("runResumeDispatch - plan-acceptance gate", () => {
  it("REFUSES resuming a paused run whose plan is NOT accepted", async () => {
    mockGetActivePlan.mockResolvedValue({ enabled: true, accepted: false, planMd: "x" });
    const result = await runResumeDispatch({ sessionId: "s1" }, CTX);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.data.outcome).toBe("blocked_error");
    expect((result.data as { reason?: string }).reason).toBe("plan_acceptance_required");
    // Short-circuits BEFORE the claim/lease machinery.
    expect(mockEnqueueRequest).not.toHaveBeenCalled();
    expect(mockClaim).not.toHaveBeenCalled();
  });

  it("REFUSES (fail closed) when the plan row cannot be read", async () => {
    mockGetActivePlan.mockResolvedValue(null);
    const result = await runResumeDispatch({ sessionId: "s1" }, CTX);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.data.outcome).toBe("blocked_error");
    expect(mockClaim).not.toHaveBeenCalled();
  });

  it("ALLOWS resuming an ACCEPTED paused run (recoverable via any resume path)", async () => {
    mockGetActivePlan.mockResolvedValue({ enabled: true, accepted: true, planMd: "x" });
    mockEnqueueRequest.mockResolvedValue({ id: 7 });
    mockClaim.mockResolvedValue({
      outcome: "lease_busy",
      currentLease: { expiresAt: new Date(Date.now() + 1000) },
    });
    const result = await runResumeDispatch({ sessionId: "s1" }, CTX);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    // Past the gate, into the claim path (here busy) — proves accepted resumes.
    expect(result.data.outcome).toBe("lease_busy");
    expect(mockClaim).toHaveBeenCalledTimes(1);
  });
});
