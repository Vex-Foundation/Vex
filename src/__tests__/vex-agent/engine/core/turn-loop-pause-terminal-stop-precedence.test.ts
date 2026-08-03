/**
 * TERMINAL-STOP PRECEDENCE for the two post-batch PAUSE writers in the turn
 * loop: `applyWaitingForWakePostBatch` (`paused_wake`) and
 * `applyPlanAcceptancePausePostBatch` (`paused_plan_acceptance`).
 *
 * Both parked the run with the unconditional `updateStatus`, so an operator
 * Stop that committed while the batch was unwinding was overwritten and the run
 * was REOPENED into a paused (resumable) state. `applyWaitingForWakePostBatch`
 * is the worse of the two: it awaits a whole forced compaction first, so the
 * window between the decision to park and the write is arbitrarily wide.
 *
 * A park is a recovery write, never a write that moves a run TO terminal, so it
 * belongs on `updateStatusIfNotTerminal` — the repo CAS that owns this
 * invariant.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockUpdateStatus = vi.fn();
const mockUpdateStatusIfNotTerminal = vi.fn().mockResolvedValue(true);
const mockGetSession = vi.fn().mockResolvedValue({ tokenCount: 10 });
const mockForcedFallback = vi.fn().mockResolvedValue({ kind: "noop" });
const mockLoggerWarn = vi.fn();

vi.mock("@vex-agent/db/repos/mission-runs.js", () => ({
  updateStatus: (...a: unknown[]) => mockUpdateStatus(...a),
  updateStatusIfNotTerminal: (...a: unknown[]) => mockUpdateStatusIfNotTerminal(...a),
}));

vi.mock("@vex-agent/db/repos/sessions.js", () => ({
  getSession: (...a: unknown[]) => mockGetSession(...a),
}));

vi.mock("@vex-agent/engine/compact-jobs/forced-fallback.js", () => ({
  maybeRunForcedCompactFallback: (...a: unknown[]) => mockForcedFallback(...a),
}));

vi.mock("@utils/logger.js", () => ({
  default: {
    info: vi.fn(),
    warn: (...a: unknown[]) => mockLoggerWarn(...a),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// Both park sites now carry the durable operator-Stop consumer, so they reach
// the runtime control plane. Stubbed to "no stop raced us" here — the consumer's
// own behaviour is pinned by `*-stop-consumer.test.ts` and the integration file.
const mockGateOnOperatorStop = vi.fn();
vi.mock("@vex-agent/engine/runtime/lease-and-status.js", () => ({
  gateOnOperatorStopWithClient: (...a: unknown[]) => mockGateOnOperatorStop(...a),
  withSessionControlLock: async <T>(
    _sessionId: string,
    fn: (client: unknown) => Promise<T>,
  ): Promise<T> => fn({}),
}));

import { applyWaitingForWakePostBatch } from "../../../../vex-agent/engine/core/turn-loop-waiting-for-wake.js";
import { applyPlanAcceptancePausePostBatch } from "../../../../vex-agent/engine/core/turn-loop-plan-acceptance-pause.js";

describe("applyWaitingForWakePostBatch — terminal-stop precedence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpdateStatusIfNotTerminal.mockResolvedValue(true);
    mockGetSession.mockResolvedValue({ tokenCount: 10 });
    mockForcedFallback.mockResolvedValue({ kind: "noop" });
    mockGateOnOperatorStop.mockResolvedValue({ kind: "clear" });
  });

  it("parks through the terminal-safe CAS, never the unconditional write", async () => {
    await applyWaitingForWakePostBatch({
      sessionId: "session-1",
      missionRunId: "run-1",
      currentTokenCount: 10,
      contextLimit: 1000,
      sessionPermission: "restricted" as const,
      handlePostCompactBookkeeping: vi.fn(),
    });

    expect(mockUpdateStatus).not.toHaveBeenCalled();
    expect(mockUpdateStatusIfNotTerminal).toHaveBeenCalledTimes(1);
    const [runId, status, reason] = mockUpdateStatusIfNotTerminal.mock.calls[0]!;
    expect(runId).toBe("run-1");
    expect(status).toBe("paused_wake");
    expect(reason).toBe("waiting_for_wake");
  });

  it("leaves a run the operator stopped mid-compaction terminal, and logs it", async () => {
    // The Stop commits inside the awaited forced compaction; the CAS refuses.
    mockUpdateStatusIfNotTerminal.mockResolvedValue(false);

    await applyWaitingForWakePostBatch({
      sessionId: "session-1",
      missionRunId: "run-1",
      currentTokenCount: 10,
      contextLimit: 1000,
      sessionPermission: "restricted" as const,
      handlePostCompactBookkeeping: vi.fn(),
    });

    expect(mockUpdateStatus).not.toHaveBeenCalled();
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      "engine.mission.pause_after_terminal",
      expect.objectContaining({ runId: "run-1", pauseStatus: "paused_wake" }),
    );
  });
});

describe("applyPlanAcceptancePausePostBatch — terminal-stop precedence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpdateStatusIfNotTerminal.mockResolvedValue(true);
    mockGateOnOperatorStop.mockResolvedValue({ kind: "clear" });
  });

  it("parks through the terminal-safe CAS, never the unconditional write", async () => {
    await applyPlanAcceptancePausePostBatch({
      sessionId: "session-1",
      missionRunId: "run-1",
    });

    expect(mockUpdateStatus).not.toHaveBeenCalled();
    expect(mockUpdateStatusIfNotTerminal).toHaveBeenCalledTimes(1);
    const [runId, status, reason] = mockUpdateStatusIfNotTerminal.mock.calls[0]!;
    expect(runId).toBe("run-1");
    expect(status).toBe("paused_plan_acceptance");
    expect(reason).toBe("plan_acceptance_required");
  });

  it("leaves a run the operator stopped terminal, and logs it", async () => {
    mockUpdateStatusIfNotTerminal.mockResolvedValue(false);

    await applyPlanAcceptancePausePostBatch({
      sessionId: "session-1",
      missionRunId: "run-1",
    });

    expect(mockUpdateStatus).not.toHaveBeenCalled();
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      "engine.mission.pause_after_terminal",
      expect.objectContaining({
        runId: "run-1",
        pauseStatus: "paused_plan_acceptance",
      }),
    );
  });
});
