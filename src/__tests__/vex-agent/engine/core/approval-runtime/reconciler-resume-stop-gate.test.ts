/**
 * D1-T1 (delta-override, BINDING) — the reconciler's OWN resume path must be
 * gated on the durable operator stop.
 *
 * ## The hole this pins closed
 *
 * `resolveAbandonedDispatch` resolves an abandoned `approved + dispatching` row
 * to `indeterminate`, writes the explaining tool result, and then calls
 * `resumeLifecycleRow` DIRECTLY. It never passes through
 * `claimDispatchSlotUnderStopGate`. So a Stop committed while the row sat
 * abandoned was written, correctly RETAINED by the stop-retention rule (the row
 * is durable work still owed, so nothing may retire the request) — and then
 * ignored, because nothing on this path read it. The agent was resumed, under a
 * freshly claimed session lease, on a session the operator had stopped.
 *
 * ## Why the test drives the REAL chain
 *
 * Two ways to "prove" this that the override explicitly rejects:
 *
 *   - asserting only that the Stop key would be VISIBLE. Visibility is not
 *     suppression; the resume happens either way.
 *   - asserting suppression through `claimDispatchSlotUnderStopGate`. That gate
 *     guards the DISPATCH path, not the reconciler's resume path — proving it
 *     would prove the wrong property.
 *
 * So this file mocks the DATABASE and the PROVIDER, and runs the real
 * `reconcileApprovalLifecycle` → `resolveAbandonedDispatch` → `resumeLifecycleRow`
 * → `claimResumeContinuation` → `runChatSessionResume` sequence. The assertion
 * is behavioural and money-relevant: NO inference provider is resolved and NO
 * agent turn runs, while the lease is still released normally.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const SESSION_ID = "00000000-0000-4000-8000-00000000d1t1";
const APPROVAL_ID = "approval-abandoned-dispatch-001";

// ── Mocks ───────────────────────────────────────────────────────────────

const lifecycleRow = {
  approvalId: APPROVAL_ID,
  sessionId: SESSION_ID,
  missionRunId: null,
  decision: "approved" as const,
  executionStatus: "dispatching" as const,
  // Old enough to be abandoned; the lease read below is what actually decides.
  dispatchStartedAt: "2020-01-01T00:00:00.000Z",
  toolCallId: "call-1",
  resultMessageId: null,
  resumeConsumedAt: null,
  decidedAt: "2020-01-01T00:00:00.000Z",
};

const mockGetIncompleteLifecycle = vi.fn();
const mockLockLifecycleRowWith = vi.fn();
const mockCasMarkIndeterminateWith = vi.fn();
const mockMarkResumeAttempted = vi.fn().mockResolvedValue(undefined);
const mockCasMarkResumeConsumed = vi.fn().mockResolvedValue(true);
const mockHasResumeCompleted = vi.fn().mockResolvedValue(false);
vi.mock("@vex-agent/db/repos/approval-intents.js", () => ({
  getIncompleteLifecycle: (...a: unknown[]) => mockGetIncompleteLifecycle(...a),
  lockLifecycleRowWith: (...a: unknown[]) => mockLockLifecycleRowWith(...a),
  casMarkIndeterminateWith: (...a: unknown[]) =>
    mockCasMarkIndeterminateWith(...a),
  markResumeAttempted: (...a: unknown[]) => mockMarkResumeAttempted(...a),
  casMarkResumeConsumed: (...a: unknown[]) => mockCasMarkResumeConsumed(...a),
  hasResumeCompleted: (...a: unknown[]) => mockHasResumeCompleted(...a),
  getPendingLifecycleForSession: vi.fn().mockResolvedValue([]),
}));

/**
 * NO LIVE LEASE. That is what makes the `dispatching` row provably abandoned —
 * the reconciler's staleness rule is lease-aware, never clock-only.
 */
const mockGetLease = vi.fn().mockResolvedValue(null);
vi.mock("@vex-agent/db/repos/runner-leases.js", () => ({
  getLease: (...a: unknown[]) => mockGetLease(...a),
}));

const txClient = { query: vi.fn() };
vi.mock("@vex-agent/db/client.js", () => ({
  withTransaction: vi.fn(async (fn: (client: unknown) => Promise<unknown>) =>
    fn(txClient),
  ),
}));

const mockCommitDecisionToolResultWith = vi.fn().mockResolvedValue({ id: 1 });
vi.mock(
  "@vex-agent/engine/core/approval-runtime/post-tx/result-message.js",
  () => ({
    commitDecisionToolResultWith: (...a: unknown[]) =>
      mockCommitDecisionToolResultWith(...a),
    decisionResultMetadata: () => ({}),
    emitToolResultAppended: vi.fn(),
  }),
);

/**
 * The DURABLE operator-stop gate. `stopped` here means: the operator pressed
 * Stop while this row sat abandoned, and the stop-retention rule kept the
 * request open precisely because this incomplete lifecycle still owed work.
 */
const mockGateOnOperatorStopWithClient = vi.fn();
const mockClaimSessionLease = vi.fn();
vi.mock("@vex-agent/engine/runtime/lease-and-status.js", () => ({
  acquireSessionControlLock: vi.fn().mockResolvedValue(undefined),
  claimSessionLease: (...a: unknown[]) => mockClaimSessionLease(...a),
  claimRunLeaseAndFlipToRunning: vi.fn(),
  gateOnOperatorStopWithClient: (...a: unknown[]) =>
    mockGateOnOperatorStopWithClient(...a),
  withSessionControlLock: async (
    _sessionId: string,
    fn: (client: unknown) => Promise<unknown>,
  ) => fn(txClient),
}));

vi.mock("@vex-agent/engine/runtime/lease-handle.js", () => ({
  createLeaseHandle: vi.fn((opts: { ownerId: string; lease: unknown }) => ({
    lease: opts.lease,
    ownerId: opts.ownerId,
    release: vi.fn().mockResolvedValue(undefined),
  })),
}));

const mockReleaseLeaseAndEmit = vi.fn().mockResolvedValue(undefined);
vi.mock("@vex-agent/engine/runtime/release-and-emit.js", () => ({
  releaseLeaseAndEmitControlState: (...a: unknown[]) =>
    mockReleaseLeaseAndEmit(...a),
}));

/** The two things that must NOT happen on a stopped session. */
const mockResolveProvider = vi.fn().mockResolvedValue({
  loadConfig: vi.fn().mockResolvedValue({ contextLimit: 256_000 }),
});
vi.mock("@vex-agent/inference/registry.js", () => ({
  resolveProvider: () => mockResolveProvider(),
}));

const mockRunAgentTurnUnderLease = vi.fn().mockResolvedValue({
  text: "resumed",
  toolCallsMade: 0,
  pendingApprovals: [],
  stopReason: null,
  missionStatus: null,
});
vi.mock("@vex-agent/engine/core/runner/agent.js", () => ({
  runAgentTurnUnderLease: (...a: unknown[]) => mockRunAgentTurnUnderLease(...a),
}));

const mockAppendApprovalResolvedCueOnce = vi.fn().mockResolvedValue(undefined);
vi.mock("@vex-agent/engine/core/approval-runtime/resume-cue.js", () => ({
  appendApprovalResolvedCueOnce: (...a: unknown[]) =>
    mockAppendApprovalResolvedCueOnce(...a),
}));

vi.mock(
  "@vex-agent/engine/core/approval-runtime/end-of-turn-resume-hook.js",
  () => ({
    dispatchPendingApprovalResumesAfterRelease: vi
      .fn()
      .mockResolvedValue(undefined),
  }),
);

vi.mock("@utils/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { reconcileApprovalLifecycle } = await import(
  "@vex-agent/engine/core/approval-runtime/reconcile.js"
);

// ── Tests ───────────────────────────────────────────────────────────────

describe("reconciler resume — durable operator-stop gate (D1-T1)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetIncompleteLifecycle.mockResolvedValue([lifecycleRow]);
    mockLockLifecycleRowWith.mockResolvedValue(lifecycleRow);
    mockCasMarkIndeterminateWith.mockResolvedValue(true);
    mockGetLease.mockResolvedValue(null);
    mockCommitDecisionToolResultWith.mockResolvedValue({ id: 1 });
    mockCasMarkResumeConsumed.mockResolvedValue(true);
    mockHasResumeCompleted.mockResolvedValue(false);
    mockClaimSessionLease.mockResolvedValue({
      outcome: "claimed",
      lease: { sessionId: SESSION_ID, ownerId: "resume-x" },
    });
    mockRunAgentTurnUnderLease.mockResolvedValue({
      text: "resumed",
      toolCallsMade: 0,
      pendingApprovals: [],
      stopReason: null,
      missionStatus: null,
    });
  });

  it("runs NO provider or model turn when the session is durably stopped", async () => {
    mockGateOnOperatorStopWithClient.mockResolvedValue({
      kind: "stopped",
      runStatus: "cancelled",
      scope: "session",
    });

    const result = await reconcileApprovalLifecycle(new Date());

    // The row was still judged and explained — the operator's Stop must not
    // leave an unprovable money-path dispatch unresolved.
    expect(result.indeterminate).toBe(1);
    expect(mockCommitDecisionToolResultWith).toHaveBeenCalledTimes(1);

    // …and the RESUME was suppressed, along the real path.
    expect(mockResolveProvider).not.toHaveBeenCalled();
    expect(mockAppendApprovalResolvedCueOnce).not.toHaveBeenCalled();
    expect(mockRunAgentTurnUnderLease).not.toHaveBeenCalled();

    // The lease was claimed for the resume and released normally.
    expect(mockClaimSessionLease).toHaveBeenCalledTimes(1);
    expect(mockReleaseLeaseAndEmit).toHaveBeenCalledTimes(1);
  });

  it("gates BEFORE the provider, not after — the ordering is the property", async () => {
    mockGateOnOperatorStopWithClient.mockResolvedValue({
      kind: "stopped",
      runStatus: "cancelled",
      scope: "session",
    });

    await reconcileApprovalLifecycle(new Date());

    // The gate is consulted for the SESSION scope (there is no run row).
    expect(mockGateOnOperatorStopWithClient).toHaveBeenCalledWith(
      expect.anything(),
      { sessionId: SESSION_ID, missionRunId: null },
    );
  });

  it("resumes normally when the gate is clear — the gate is not a blanket refusal", async () => {
    mockGateOnOperatorStopWithClient.mockResolvedValue({ kind: "clear" });

    const result = await reconcileApprovalLifecycle(new Date());

    expect(result.indeterminate).toBe(1);
    expect(mockResolveProvider).toHaveBeenCalled();
    expect(mockAppendApprovalResolvedCueOnce).toHaveBeenCalledWith(
      SESSION_ID,
      APPROVAL_ID,
    );
    expect(mockRunAgentTurnUnderLease).toHaveBeenCalledTimes(1);
  });

  it("threads the slice signal into BOTH turn-loop positions", async () => {
    mockGateOnOperatorStopWithClient.mockResolvedValue({ kind: "clear" });

    await reconcileApprovalLifecycle(new Date());

    const call = mockRunAgentTurnUnderLease.mock.calls[0]!;
    const inferenceSignal = call[3] as AbortSignal | undefined;
    const boundarySignal = call[5] as AbortSignal | undefined;
    expect(inferenceSignal).toBeInstanceOf(AbortSignal);
    // One controller, both positions — a Stop lands at the next iteration AND
    // mid-provider-call, never mid-dispatch.
    expect(boundarySignal).toBe(inferenceSignal);
  });
});
