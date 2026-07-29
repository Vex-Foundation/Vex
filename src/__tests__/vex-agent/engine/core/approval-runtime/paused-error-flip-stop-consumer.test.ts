/**
 * DURABLE operator-Stop consumer at the APPROVAL post-decision recovery flip
 * (`approval-runtime/post-tx/recovery.ts`, `paused_error` /
 * `approval_post_decision`).
 *
 * Site-specific hazard: this helper is shared by the approve, dispatch-throw,
 * reject, and policy-drift side-effect paths, and every caller invokes it while
 * a MORE important failure is already in flight. Its never-throws contract is
 * therefore load-bearing: adding the gate must not turn a recovery park into a
 * second exception that masks the original error. The gate lives INSIDE the
 * existing try/catch for exactly that reason.
 *
 * Pinned here: gate consulted under the lock on the flip's own client; no park
 * write when it reports `stopped`; the helper still never throws when the gate
 * or the lock itself blows up.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockUpdateStatusIfNotTerminal = vi.fn();
const mockGateOnOperatorStop = vi.fn();
const mockWithSessionControlLock = vi.fn();
const mockLoggerInfo = vi.fn();
const mockLoggerWarn = vi.fn();

const fakeClient = { id: "fake-client" };

vi.mock("../../../../../vex-agent/db/repos/mission-runs.js", () => ({
  updateStatusIfNotTerminal: (...a: unknown[]) =>
    mockUpdateStatusIfNotTerminal(...a),
}));

vi.mock("../../../../../vex-agent/engine/runtime/lease-and-status.js", () => ({
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

const { flipRunToPausedError } = await import(
  "../../../../../vex-agent/engine/core/approval-runtime/post-tx/recovery.js"
);

const INPUT = {
  approvalId: "appr-1",
  sessionId: "sess-1",
  missionRunId: "run-1",
  errorKind: "ResumeClaimFailed",
  evidence: { errorHash: "abc123" },
};

describe("approval paused_error flip — durable operator-Stop consumer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpdateStatusIfNotTerminal.mockResolvedValue(true);
    mockGateOnOperatorStop.mockResolvedValue({ kind: "clear" });
    mockWithSessionControlLock.mockImplementation(
      async (_sessionId: string, fn: (c: unknown) => Promise<unknown>) =>
        fn(fakeClient),
    );
  });

  it("runs the gate under the session control lock, on the flip's own client", async () => {
    await flipRunToPausedError(INPUT);

    expect(mockWithSessionControlLock.mock.calls[0]![0]).toBe("sess-1");
    expect(mockGateOnOperatorStop).toHaveBeenCalledWith(fakeClient, {
      sessionId: "sess-1",
      missionRunId: "run-1",
    });
    expect(mockUpdateStatusIfNotTerminal.mock.calls[0]!.at(-1)).toBe(fakeClient);
  });

  it("applies a queued Stop instead of flipping", async () => {
    mockGateOnOperatorStop.mockResolvedValue({
      kind: "stopped",
      runStatus: "stopped",
    });

    await flipRunToPausedError(INPUT);

    // FAIL-CLOSED: no recovery park on a run the operator already stopped.
    expect(mockUpdateStatusIfNotTerminal).not.toHaveBeenCalled();
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      "engine.approval_runtime.paused_error_consumed_operator_stop",
      expect.objectContaining({
        approvalId: "appr-1",
        sessionId: "sess-1",
        missionRunId: "run-1",
      }),
    );
  });

  it("flips normally when no Stop is queued", async () => {
    await flipRunToPausedError(INPUT);

    expect(mockUpdateStatusIfNotTerminal).toHaveBeenCalledTimes(1);
    const [runId, status, reason, payload] =
      mockUpdateStatusIfNotTerminal.mock.calls[0]!;
    expect(runId).toBe("run-1");
    expect(status).toBe("paused_error");
    expect(reason).toBe("approval_post_decision");
    expect(payload).toMatchObject({
      evidence: {
        approvalId: "appr-1",
        errorKind: "ResumeClaimFailed",
        errorHash: "abc123",
      },
    });
  });

  it("still NEVER throws when the gate itself fails", async () => {
    // Callers run this while a more important failure is propagating; a throw
    // here would replace that failure with a recovery-path error.
    mockGateOnOperatorStop.mockRejectedValue(new Error("lock timeout"));

    await expect(flipRunToPausedError(INPUT)).resolves.toBeUndefined();

    expect(mockLoggerWarn).toHaveBeenCalledWith(
      "engine.approval_runtime.paused_error_update_failed",
      expect.objectContaining({ approvalId: "appr-1", missionRunId: "run-1" }),
    );
  });

  it("still NEVER throws when the lock helper itself fails", async () => {
    mockWithSessionControlLock.mockRejectedValue(new Error("pool exhausted"));

    await expect(flipRunToPausedError(INPUT)).resolves.toBeUndefined();

    expect(mockLoggerWarn).toHaveBeenCalledWith(
      "engine.approval_runtime.paused_error_update_failed",
      expect.anything(),
    );
  });

  it("surfaces a refused CAS as the existing skipped-terminal-run event", async () => {
    mockUpdateStatusIfNotTerminal.mockResolvedValue(false);

    await flipRunToPausedError(INPUT);

    expect(mockLoggerInfo).toHaveBeenCalledWith(
      "engine.approval_runtime.paused_error_skipped_terminal_run",
      expect.objectContaining({ approvalId: "appr-1", missionRunId: "run-1" }),
    );
  });
});
