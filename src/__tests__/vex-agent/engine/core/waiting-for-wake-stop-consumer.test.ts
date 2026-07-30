/**
 * DURABLE operator-Stop consumer at the POST-BATCH wake park
 * (`turn-loop-waiting-for-wake.ts`, `paused_wake` / `waiting_for_wake`).
 *
 * Site-specific hazard: this park sits AFTER an awaited forced compaction, so
 * the window between the loop's last iteration checkpoint and the write is
 * arbitrarily wide — and once parked the run reaches no further checkpoint until
 * the wake fires. A `stop_terminal` queued inside that window had no reader.
 *
 * Pinned here: gate consulted under the lock on the park's own client; no park
 * write when it reports `stopped`; the plain refused-CAS branch keeps its
 * existing `pause_after_terminal` warn; a chat session never gates.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockUpdateStatus = vi.fn();
const mockUpdateStatusIfNotTerminal = vi.fn();
const mockGetSession = vi.fn();
const mockForcedFallback = vi.fn();
const mockGateOnOperatorStop = vi.fn();
const mockWithSessionControlLock = vi.fn();
const mockLoggerWarn = vi.fn();
const mockLoggerInfo = vi.fn();

const fakeClient = { id: "fake-client" };

vi.mock("@vex-agent/db/repos/mission-runs.js", () => ({
  updateStatus: (...a: unknown[]) => mockUpdateStatus(...a),
  updateStatusIfNotTerminal: (...a: unknown[]) =>
    mockUpdateStatusIfNotTerminal(...a),
}));

vi.mock("@vex-agent/db/repos/sessions.js", () => ({
  getSession: (...a: unknown[]) => mockGetSession(...a),
}));

vi.mock("@vex-agent/engine/compact-jobs/forced-fallback.js", () => ({
  maybeRunForcedCompactFallback: (...a: unknown[]) => mockForcedFallback(...a),
}));

vi.mock("@vex-agent/engine/runtime/lease-and-status.js", () => ({
  gateOnOperatorStopWithClient: (...a: unknown[]) => mockGateOnOperatorStop(...a),
  withSessionControlLock: (...a: unknown[]) => mockWithSessionControlLock(...a),
}));

vi.mock("@utils/logger.js", () => ({
  default: {
    info: (...a: unknown[]) => mockLoggerInfo(...a),
    warn: (...a: unknown[]) => mockLoggerWarn(...a),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

const { applyWaitingForWakePostBatch } = await import(
  "../../../../vex-agent/engine/core/turn-loop-waiting-for-wake.js"
);

const ARGS = {
  sessionId: "session-1",
  missionRunId: "run-1" as string | null,
  currentTokenCount: 10,
  contextLimit: 1000,
};

describe("paused_wake post-batch park — durable operator-Stop consumer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpdateStatusIfNotTerminal.mockResolvedValue(true);
    mockGetSession.mockResolvedValue({ tokenCount: 10 });
    mockForcedFallback.mockResolvedValue({ kind: "noop" });
    mockGateOnOperatorStop.mockResolvedValue({ kind: "clear" });
    mockWithSessionControlLock.mockImplementation(
      async (_sessionId: string, fn: (c: unknown) => Promise<unknown>) =>
        fn(fakeClient),
    );
  });

  it("runs the gate under the session control lock, on the park's own client", async () => {
    await applyWaitingForWakePostBatch({
      ...ARGS,
      handlePostCompactBookkeeping: vi.fn(),
    });

    expect(mockWithSessionControlLock.mock.calls[0]![0]).toBe("session-1");
    expect(mockGateOnOperatorStop).toHaveBeenCalledWith(fakeClient, {
      sessionId: "session-1",
      missionRunId: "run-1",
    });
    expect(mockUpdateStatusIfNotTerminal.mock.calls[0]!.at(-1)).toBe(fakeClient);
  });

  it("applies a queued Stop instead of parking", async () => {
    mockGateOnOperatorStop.mockResolvedValue({
      kind: "stopped",
      runStatus: "stopped",
    });

    await applyWaitingForWakePostBatch({
      ...ARGS,
      handlePostCompactBookkeeping: vi.fn(),
    });

    // FAIL-CLOSED: nothing written, through either repo entry point.
    expect(mockUpdateStatusIfNotTerminal).not.toHaveBeenCalled();
    expect(mockUpdateStatus).not.toHaveBeenCalled();
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      "engine.mission.wake_pause_consumed_operator_stop",
      expect.objectContaining({ sessionId: "session-1", runId: "run-1" }),
    );
    // A consumed stop is not the same event as a superseded park.
    expect(mockLoggerWarn).not.toHaveBeenCalledWith(
      "engine.mission.pause_after_terminal",
      expect.anything(),
    );
  });

  it("keeps the existing warn when the CAS itself refuses", async () => {
    mockUpdateStatusIfNotTerminal.mockResolvedValue(false);

    await applyWaitingForWakePostBatch({
      ...ARGS,
      handlePostCompactBookkeeping: vi.fn(),
    });

    expect(mockLoggerWarn).toHaveBeenCalledWith(
      "engine.mission.pause_after_terminal",
      expect.objectContaining({ runId: "run-1", pauseStatus: "paused_wake" }),
    );
  });

  it("a chat session neither gates nor parks", async () => {
    await applyWaitingForWakePostBatch({
      ...ARGS,
      missionRunId: null,
      handlePostCompactBookkeeping: vi.fn(),
    });

    expect(mockWithSessionControlLock).not.toHaveBeenCalled();
    expect(mockUpdateStatusIfNotTerminal).not.toHaveBeenCalled();
  });
});
