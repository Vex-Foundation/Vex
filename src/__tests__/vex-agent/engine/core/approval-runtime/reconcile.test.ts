/**
 * Approval lifecycle reconciler (A6) — the durable floor under every faster
 * resume path.
 *
 * Pinned invariants:
 *   - NEVER re-dispatch an approved tool during recovery. An unprovable
 *     outcome is `indeterminate` with a structural, honest tool result — never
 *     success, never failure.
 *   - Staleness is LEASE-AWARE, never time-only. A live lease outranks any
 *     `dispatch_started_at` age, because a heartbeated runner legitimately
 *     outlives a fixed threshold and declaring a healthy in-flight money-path
 *     dispatch "unknown" would be a false alarm.
 *   - `approved` + `not_started` is the ONE state where dispatch is safe: the
 *     CAS is the only exit from it, so the tool provably never ran.
 *   - A consumed resume is never delivered twice.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const SESSION_ID = "00000000-0000-4000-8000-0000000000c6";
const APPROVAL_ID = "approval-reconcile-001";

// ── Mocks ───────────────────────────────────────────────────────────────

const mockGetIncompleteLifecycle = vi.fn();
const mockLockLifecycleRowWith = vi.fn();
const mockCasMarkIndeterminateWith = vi.fn();
vi.mock("@vex-agent/db/repos/approval-intents.js", () => ({
  getIncompleteLifecycle: (...a: unknown[]) => mockGetIncompleteLifecycle(...a),
  lockLifecycleRowWith: (...a: unknown[]) => mockLockLifecycleRowWith(...a),
  casMarkIndeterminateWith: (...a: unknown[]) =>
    mockCasMarkIndeterminateWith(...a),
  casMarkResumeConsumed: vi.fn().mockResolvedValue(true),
  markResumeAttempted: vi.fn().mockResolvedValue(undefined),
}));

const mockGetLease = vi.fn();
vi.mock("@vex-agent/db/repos/runner-leases.js", () => ({
  getLease: (...a: unknown[]) => mockGetLease(...a),
}));

const txClient = { query: vi.fn() };
vi.mock("@vex-agent/db/client.js", () => ({
  withTransaction: vi.fn(async (fn: (client: unknown) => Promise<unknown>) => {
    const out = await fn(txClient);
    callOrder.push("commit");
    return out;
  }),
}));

const mockClaimResumeContinuation = vi.fn();
const mockRunResumeAfterDecision = vi.fn();
vi.mock("@vex-agent/engine/core/approval-runtime/continuation.js", () => ({
  claimResumeContinuation: (...a: unknown[]) =>
    mockClaimResumeContinuation(...a),
  runResumeAfterDecision: (...a: unknown[]) => mockRunResumeAfterDecision(...a),
}));

/**
 * Ordered log proving the `indeterminate` status and its tool result land in
 * ONE transaction, and that the event is published only after the COMMIT.
 */
const callOrder: string[] = [];

const mockCommitDecisionToolResultWith = vi.fn();
const mockEmitToolResultAppended = vi.fn();
vi.mock(
  "@vex-agent/engine/core/approval-runtime/post-tx/result-message.js",
  () => ({
    commitDecisionToolResultWith: (...a: unknown[]) => {
      callOrder.push("result-row");
      return mockCommitDecisionToolResultWith(...a);
    },
    emitToolResultAppended: (...a: unknown[]) => {
      callOrder.push("emit");
      return mockEmitToolResultAppended(...a);
    },
    decisionResultMetadata: (payload: Record<string, unknown>) => ({
      source: "tool",
      messageType: "tool_result",
      visibility: "internal",
      payload,
    }),
  }),
);

const mockApplyApproveSideEffects = vi.fn();
vi.mock("@vex-agent/engine/core/approval-runtime/post-tx.js", () => ({
  applyApproveSideEffects: (...a: unknown[]) =>
    mockApplyApproveSideEffects(...a),
}));

const mockLockAndLoadSnapshot = vi.fn();
vi.mock("@vex-agent/engine/core/approval-runtime/snapshot/compare.js", () => ({
  lockAndLoadSnapshot: (...a: unknown[]) => mockLockAndLoadSnapshot(...a),
  getDbNow: vi.fn(),
}));

// Relative specifier, not `@vex-lib` — that alias exists only in vex-app's
// resolver, so the root vitest run would not match the mock.
const mockEmitBugReportSafe = vi.fn().mockResolvedValue(undefined);
vi.mock("../../../../../lib/diagnostics/bug-report-sink.js", () => ({
  emitBugReportSafe: (...a: unknown[]) => mockEmitBugReportSafe(...a),
  noopBugReportSink: { emit: vi.fn() },
}));

vi.mock("@utils/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { reconcileApprovalLifecycle } = await import(
  "@vex-agent/engine/core/approval-runtime/reconcile.js"
);
const { STALE_DISPATCH_THRESHOLD_MS, TOOL_RESULT_INDETERMINATE_MESSAGE } =
  await import("@vex-agent/engine/core/approval-runtime/helpers.js");

// ── Fixtures ────────────────────────────────────────────────────────────

const NOW = new Date("2026-07-28T12:00:00.000Z");

function lifecycleRow(overrides: Record<string, unknown> = {}) {
  return {
    approvalId: APPROVAL_ID,
    sessionId: SESSION_ID,
    missionRunId: null,
    toolCallId: "tc-1",
    decision: "approved",
    executionStatus: "not_started",
    dispatchStartedAt: null,
    resultMessageId: null,
    resumeConsumedAt: null,
    ...overrides,
  };
}

/** `dispatch_started_at` comfortably older than the staleness threshold. */
function longAgo(): string {
  return new Date(
    NOW.getTime() - STALE_DISPATCH_THRESHOLD_MS - 60_000,
  ).toISOString();
}

function liveLease() {
  return {
    sessionId: SESSION_ID,
    missionRunId: null,
    ownerId: "healthy-runner",
    processKind: "electron_main",
    acquiredAt: new Date(NOW.getTime() - 60_000),
    // Heartbeated moments ago — this runner is alive and working.
    heartbeatAt: new Date(NOW.getTime() - 5_000),
    expiresAt: new Date(NOW.getTime() + 240_000),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  callOrder.length = 0;
  mockGetIncompleteLifecycle.mockResolvedValue([]);
  mockGetLease.mockResolvedValue(null);
  mockCasMarkIndeterminateWith.mockResolvedValue(true);
  mockCommitDecisionToolResultWith.mockResolvedValue({
    id: 99,
    role: "tool",
    content: "…",
    timestamp: "2026-07-28T12:00:00.000Z",
  });
  mockRunResumeAfterDecision.mockResolvedValue({
    text: null,
    toolCallsMade: 0,
    pendingApprovals: [],
    stopReason: null,
    missionStatus: null,
  });
  mockClaimResumeContinuation.mockResolvedValue({
    outcome: "claimed",
    continuation: {
      kind: "chat_session",
      sessionId: SESSION_ID,
      approvalId: APPROVAL_ID,
      ownerId: "reconcile-x",
      leaseHandle: { release: vi.fn() },
    },
  });
  mockLockLifecycleRowWith.mockImplementation(async () =>
    lifecycleRow({ executionStatus: "dispatching", dispatchStartedAt: longAgo() }),
  );
  mockLockAndLoadSnapshot.mockResolvedValue({
    approval_id: APPROVAL_ID,
    session_id: SESSION_ID,
    mission_run_id: null,
    queue_tool_call: { command: "wallet_send_confirm", args: {} },
    queue_tool_call_id: "tc-1",
    queue_permission_at_enqueue: "restricted",
    queue_resolved_at: "2026-07-28T11:00:00.000Z",
  });
  mockApplyApproveSideEffects.mockResolvedValue({
    kind: "dispatched",
    continuation: null,
  });
});

// ── Branch 1: approved + not_started → dispatch now ─────────────────────

describe("reconciler branch: approved + not_started", () => {
  it("dispatches, because `not_started` PROVES the tool never ran", async () => {
    mockGetIncompleteLifecycle.mockResolvedValue([
      lifecycleRow({ executionStatus: "not_started" }),
    ]);

    const result = await reconcileApprovalLifecycle(NOW);

    expect(result.dispatched).toBe(1);
    expect(mockApplyApproveSideEffects).toHaveBeenCalledTimes(1);
    // Replay goes through the normal approve side effects, which begin with the
    // dispatch CAS — so a concurrent writer still cannot cause a double run.
    expect(mockApplyApproveSideEffects.mock.calls[0]![1]).toMatchObject({
      type: "approved_in_tx",
    });
  });

  it("a busy lease defers instead of dispatching", async () => {
    mockGetIncompleteLifecycle.mockResolvedValue([
      lifecycleRow({ executionStatus: "not_started" }),
    ]);
    mockApplyApproveSideEffects.mockResolvedValue({ kind: "deferred_busy" });

    const result = await reconcileApprovalLifecycle(NOW);

    expect(result.dispatched).toBe(0);
    expect(result.skippedLeaseHeld).toBe(1);
  });

  it("a REJECTED row in not_started is never dispatched", async () => {
    // Rejections also sit at `not_started` (nothing ran). Only `approved` may
    // take the dispatch branch.
    mockGetIncompleteLifecycle.mockResolvedValue([
      lifecycleRow({ decision: "rejected", executionStatus: "not_started" }),
    ]);

    const result = await reconcileApprovalLifecycle(NOW);

    expect(mockApplyApproveSideEffects).not.toHaveBeenCalled();
    expect(result.dispatched).toBe(0);
  });
});

// ── Branch 2: dispatching + lease-aware stale → indeterminate ───────────

describe("reconciler branch: abandoned dispatch → indeterminate", () => {
  beforeEach(() => {
    mockGetIncompleteLifecycle.mockResolvedValue([
      lifecycleRow({
        executionStatus: "dispatching",
        dispatchStartedAt: longAgo(),
      }),
    ]);
  });

  it("old dispatch + NO lease → indeterminate, and the tool is NEVER re-dispatched", async () => {
    const result = await reconcileApprovalLifecycle(NOW);

    expect(result.indeterminate).toBe(1);
    expect(mockCasMarkIndeterminateWith).toHaveBeenCalledWith(
      txClient,
      APPROVAL_ID,
    );
    // THE money-path invariant: recovery must never run an approved tool again.
    expect(mockApplyApproveSideEffects).not.toHaveBeenCalled();
  });

  it("tells the agent the outcome is UNKNOWN — not success, not failure", async () => {
    await reconcileApprovalLifecycle(NOW);

    const committed = mockCommitDecisionToolResultWith.mock.calls[0]![1] as {
      content: string;
      payload: Record<string, unknown>;
    };
    expect(committed.content).toBe(TOOL_RESULT_INDETERMINATE_MESSAGE);
    expect(committed.content).toMatch(/unknown/i);
    expect(committed.content).toMatch(/NOT retried/);
    expect(committed.payload).toMatchObject({
      success: false,
      indeterminate: true,
    });
  });

  /**
   * ATOMICITY. `indeterminate` is TERMINAL and appears in no scan's incomplete
   * set, so a crash between a status commit and a separate result commit would
   * leave the agent waiting forever for an answer to a tool call that had one
   * recorded nowhere — and nothing would ever reconcile it again.
   */
  it("writes the status and its tool result on the SAME transaction client", async () => {
    await reconcileApprovalLifecycle(NOW);

    expect(mockCasMarkIndeterminateWith).toHaveBeenCalledWith(
      txClient,
      APPROVAL_ID,
    );
    expect(mockCommitDecisionToolResultWith).toHaveBeenCalledWith(
      txClient,
      expect.objectContaining({ approvalId: APPROVAL_ID }),
    );
  });

  it("emits the transcript event only AFTER that transaction commits", async () => {
    await reconcileApprovalLifecycle(NOW);

    expect(callOrder).toEqual(["result-row", "commit", "emit"]);
    expect(mockEmitToolResultAppended).toHaveBeenCalledWith(
      SESSION_ID,
      expect.objectContaining({ id: 99 }),
      expect.objectContaining({ messageType: "tool_result" }),
    );
  });

  it("a failing result write rolls the status back with it (no orphan verdict)", async () => {
    mockCommitDecisionToolResultWith.mockRejectedValue(new Error("pg down"));

    const result = await reconcileApprovalLifecycle(NOW);

    // The row is counted as errored and retried next cycle — it is still
    // `dispatching`, because the CAS was in the transaction that rolled back.
    expect(result.errored).toBe(1);
    expect(result.indeterminate).toBe(0);
    expect(callOrder).not.toContain("commit");
    expect(mockEmitToolResultAppended).not.toHaveBeenCalled();
    // And above all: no re-dispatch was attempted to "find out" what happened.
    expect(mockApplyApproveSideEffects).not.toHaveBeenCalled();
  });

  it("raises a bug report and resumes the agent", async () => {
    await reconcileApprovalLifecycle(NOW);

    expect(mockEmitBugReportSafe).toHaveBeenCalledTimes(1);
    const report = mockEmitBugReportSafe.mock.calls[0]![1] as {
      title: string;
      severity: string;
    };
    expect(report.title).toBe("approvals.dispatch_indeterminate");
    expect(report.severity).toBe("error");
    expect(mockRunResumeAfterDecision).toHaveBeenCalledTimes(1);
  });

  it("LEASE-AWARE: a live heartbeated lease + an old stamp stays `dispatching`", async () => {
    // The regression this whole design exists to prevent. A clock-only sweep
    // would convert a healthy in-flight money-path dispatch into "unknown".
    mockGetLease.mockResolvedValue(liveLease());

    const result = await reconcileApprovalLifecycle(NOW);

    expect(result.indeterminate).toBe(0);
    expect(result.skippedLeaseHeld).toBe(1);
    expect(mockCasMarkIndeterminateWith).not.toHaveBeenCalled();
    expect(mockCommitDecisionToolResultWith).not.toHaveBeenCalled();
    expect(mockApplyApproveSideEffects).not.toHaveBeenCalled();
  });

  it("an EXPIRED lease does not protect a stale dispatch", async () => {
    mockGetLease.mockResolvedValue({
      ...liveLease(),
      expiresAt: new Date(NOW.getTime() - 1_000),
    });

    const result = await reconcileApprovalLifecycle(NOW);

    expect(result.indeterminate).toBe(1);
  });

  it("a RECENT dispatch is left alone even with no lease", async () => {
    mockLockLifecycleRowWith.mockResolvedValue(
      lifecycleRow({
        executionStatus: "dispatching",
        dispatchStartedAt: new Date(NOW.getTime() - 30_000).toISOString(),
      }),
    );

    const result = await reconcileApprovalLifecycle(NOW);

    expect(result.indeterminate).toBe(0);
    expect(mockCasMarkIndeterminateWith).not.toHaveBeenCalled();
  });

  it("the CAS losing (a writer finished underneath us) makes it a no-op", async () => {
    mockCasMarkIndeterminateWith.mockResolvedValue(false);

    const result = await reconcileApprovalLifecycle(NOW);

    expect(result.indeterminate).toBe(0);
    expect(mockCommitDecisionToolResultWith).not.toHaveBeenCalled();
  });

  it("re-reads the row UNDER THE LOCK, so a completed dispatch is not clobbered", async () => {
    // The scan row said `dispatching`; by the time we hold the lock it has
    // settled. Trusting the unlocked scan would rewrite a real result.
    mockLockLifecycleRowWith.mockResolvedValue(
      lifecycleRow({ executionStatus: "succeeded", resultMessageId: 7 }),
    );

    const result = await reconcileApprovalLifecycle(NOW);

    expect(result.indeterminate).toBe(0);
    expect(mockCasMarkIndeterminateWith).not.toHaveBeenCalled();
  });
});

// ── Branch 4: legacy rows (pre-056, no dispatch_started_at) ─────────────

describe("reconciler branch: legacy row without dispatch_started_at", () => {
  it("is treated as the stale-dispatch branch (no age to trust)", async () => {
    mockGetIncompleteLifecycle.mockResolvedValue([
      lifecycleRow({ executionStatus: "dispatching", dispatchStartedAt: null }),
    ]);
    mockLockLifecycleRowWith.mockResolvedValue(
      lifecycleRow({ executionStatus: "dispatching", dispatchStartedAt: null }),
    );

    const result = await reconcileApprovalLifecycle(NOW);

    expect(result.indeterminate).toBe(1);
    expect(mockApplyApproveSideEffects).not.toHaveBeenCalled();
  });

  it("but a live lease STILL protects it", async () => {
    mockGetIncompleteLifecycle.mockResolvedValue([
      lifecycleRow({ executionStatus: "dispatching", dispatchStartedAt: null }),
    ]);
    mockLockLifecycleRowWith.mockResolvedValue(
      lifecycleRow({ executionStatus: "dispatching", dispatchStartedAt: null }),
    );
    mockGetLease.mockResolvedValue(liveLease());

    const result = await reconcileApprovalLifecycle(NOW);

    expect(result.indeterminate).toBe(0);
    expect(result.skippedLeaseHeld).toBe(1);
  });
});

// ── Branch 3: committed result, unconsumed → claim and resume ───────────

describe("reconciler branch: unconsumed result → resume", () => {
  it("resumes a committed-but-unconsumed result exactly once", async () => {
    mockGetIncompleteLifecycle.mockResolvedValue([
      lifecycleRow({
        executionStatus: "succeeded",
        resultMessageId: 4242,
        resumeConsumedAt: null,
      }),
    ]);

    const result = await reconcileApprovalLifecycle(NOW);

    expect(result.resumed).toBe(1);
    expect(mockRunResumeAfterDecision).toHaveBeenCalledTimes(1);
    // Never re-runs the tool to "check" what happened.
    expect(mockApplyApproveSideEffects).not.toHaveBeenCalled();
  });

  it("crash after the result commit AND after a recorded attempt still resumes", async () => {
    // `resumed_at` is attempt audit, never a gate: the process died after
    // stamping an attempt but before the lease-held core began consuming.
    // Eligibility depends ONLY on result-exists + not-consumed.
    mockGetIncompleteLifecycle.mockResolvedValue([
      lifecycleRow({
        executionStatus: "succeeded",
        resultMessageId: 4242,
        resumeConsumedAt: null,
      }),
    ]);

    const result = await reconcileApprovalLifecycle(NOW);

    expect(result.resumed).toBe(1);
  });

  it("a lease held by a live runner defers the resume rather than stealing it", async () => {
    mockGetIncompleteLifecycle.mockResolvedValue([
      lifecycleRow({ executionStatus: "succeeded", resultMessageId: 4242 }),
    ]);
    mockClaimResumeContinuation.mockResolvedValue({ outcome: "busy" });

    const result = await reconcileApprovalLifecycle(NOW);

    expect(result.resumed).toBe(0);
    expect(result.skippedLeaseHeld).toBe(1);
    expect(mockRunResumeAfterDecision).not.toHaveBeenCalled();
  });

  it("an ALREADY-CONSUMED resume is never picked up again", async () => {
    // The consumption marker is what stops the reconciler re-invoking the agent
    // on every five-minute cycle for the rest of the session's life. A consumed
    // row does not even appear in the scan, but assert the guard end to end.
    mockGetIncompleteLifecycle.mockResolvedValue([
      lifecycleRow({
        executionStatus: "succeeded",
        resultMessageId: 4242,
        resumeConsumedAt: "2026-07-28T11:59:00.000Z",
      }),
    ]);

    const result = await reconcileApprovalLifecycle(NOW);

    expect(result.resumed).toBe(0);
    expect(mockRunResumeAfterDecision).not.toHaveBeenCalled();
    expect(mockApplyApproveSideEffects).not.toHaveBeenCalled();
  });

  it("a rejection's unconsumed result resumes too", async () => {
    mockGetIncompleteLifecycle.mockResolvedValue([
      lifecycleRow({
        decision: "rejected",
        executionStatus: "not_started",
        resultMessageId: 77,
      }),
    ]);

    const result = await reconcileApprovalLifecycle(NOW);

    expect(result.resumed).toBe(1);
    expect(mockApplyApproveSideEffects).not.toHaveBeenCalled();
  });
});

// ── Pass-level behaviour ────────────────────────────────────────────────

describe("reconciler pass", () => {
  it("isolates a broken row so the rest of the cycle still runs", async () => {
    mockGetIncompleteLifecycle.mockResolvedValue([
      lifecycleRow({ approvalId: "bad", executionStatus: "not_started" }),
      lifecycleRow({
        approvalId: "good",
        executionStatus: "succeeded",
        resultMessageId: 4242,
      }),
    ]);
    mockApplyApproveSideEffects.mockRejectedValueOnce(new Error("pg down"));

    const result = await reconcileApprovalLifecycle(NOW);

    expect(result.errored).toBe(1);
    expect(result.resumed).toBe(1);
  });

  it("is a no-op on a quiet queue", async () => {
    const result = await reconcileApprovalLifecycle(NOW);

    expect(result).toMatchObject({
      examined: 0,
      dispatched: 0,
      indeterminate: 0,
      resumed: 0,
      skippedRunNotResumable: 0,
      errored: 0,
    });
  });

  /**
   * Finding 3, reconciler half. A row whose run has left the claimable statuses
   * is reported apart from a busy lease, because the two need opposite
   * responses: a lease clears itself within its TTL, a run status does not. The
   * separate counter is the operator's only signal that such rows are piling up
   * — the sweep's batch is fixed-size and age-ordered, so an accumulation of
   * them is exactly what the fairness ordering in the lifecycle repo exists to
   * stop from crowding out newer approvals.
   */
  it("counts a not-resumable run apart from a held lease, and keeps going", async () => {
    mockClaimResumeContinuation.mockResolvedValueOnce({
      outcome: "status_mismatch",
      currentStatus: "cancelled",
    });
    mockGetIncompleteLifecycle.mockResolvedValue([
      lifecycleRow({
        approvalId: "stuck",
        missionRunId: "run-cancelled",
        executionStatus: "succeeded",
        resultMessageId: 4242,
      }),
      lifecycleRow({
        approvalId: "newer",
        executionStatus: "succeeded",
        resultMessageId: 4243,
      }),
    ]);

    const result = await reconcileApprovalLifecycle(NOW);

    expect(result.skippedRunNotResumable).toBe(1);
    expect(result.skippedLeaseHeld).toBe(0);
    expect(result.errored).toBe(0);
    // The row behind it still got its wake.
    expect(result.resumed).toBe(1);
    expect(mockRunResumeAfterDecision).toHaveBeenCalledTimes(1);
  });
});
