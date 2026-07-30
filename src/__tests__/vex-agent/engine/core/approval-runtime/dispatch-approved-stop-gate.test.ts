/**
 * The money-path wiring of B2(c): an approved MUTATING tool must not execute
 * after the operator pressed Stop.
 *
 * Scope note, so the next session does not over-trust this file. What is
 * proven HERE is the wiring and the ordering inside `applyApproveSideEffects`:
 * that the gate and the dispatch-slot CAS share ONE locked transaction sitting
 * immediately before `dispatchTool`, that a `stopped` verdict suppresses the
 * dispatch entirely, that the
 * `dispatching` row is settled instead of being abandoned for the reconciler
 * to call `indeterminate`, that a Stop landing in the unlocked window AFTER
 * the dispatch is applied durably once the result is safe (never before it,
 * and never by re-dispatching anything), and that the lease is handed back.
 * The failure-exit half of that invariant lives next door in
 * `dispatch-approved-stop-precedence.test.ts`. What is NOT
 * proven here is the serialization boundary itself — a mocked gate cannot
 * demonstrate that a concurrent Stop is ordered against this decision. That
 * lives in `integration/engine/operator-stop-boundary.int.test.ts`, against a
 * real Postgres with two real clients.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockCommitApprovedToolResult = vi.fn();
const mockCommitDispatchFailureToolResult = vi.fn();
vi.mock(
  "@vex-agent/engine/core/approval-runtime/post-tx/result-message.js",
  () => ({
    commitApprovedToolResult: (...a: unknown[]) =>
      mockCommitApprovedToolResult(...a),
    commitDispatchFailureToolResult: (...a: unknown[]) =>
      mockCommitDispatchFailureToolResult(...a),
    commitDecisionToolResult: vi.fn(),
  }),
);

const mockDispatchTool = vi.fn();
vi.mock("@vex-agent/tools/dispatcher.js", () => ({
  dispatchTool: (...a: unknown[]) => mockDispatchTool(...a),
}));

const mockCasMarkDispatching = vi.fn().mockResolvedValue(true);
vi.mock("@vex-agent/db/repos/approval-intents.js", () => ({
  markExecutionStatus: vi.fn(),
  casMarkDispatchingWith: (...a: unknown[]) => mockCasMarkDispatching(...a),
}));

/**
 * The PRE-dispatch gate. It runs on the caller's client now, because the
 * slot CAS and the gate share one transaction — see `dispatch-slot-gate.ts`.
 * The POST-dispatch consumer (`applyQueuedOperatorStop`) still opens its own
 * transaction, so the two are separately observable here, which is what lets
 * this file assert the ordering rather than assume it.
 */
const mockPreDispatchGate = vi.fn();
const mockGateOnOperatorStopTransaction = vi.fn();
const mockAcquireSessionControlLock = vi.fn();
vi.mock("@vex-agent/engine/runtime/lease-and-status.js", () => ({
  gateOnOperatorStopTransaction: (...a: unknown[]) =>
    mockGateOnOperatorStopTransaction(...a),
  gateOnOperatorStopWithClient: (...a: unknown[]) => mockPreDispatchGate(...a),
  acquireSessionControlLock: (...a: unknown[]) =>
    mockAcquireSessionControlLock(...a),
  withSessionControlLock: async <T>(
    _sessionId: string,
    fn: (client: unknown) => Promise<T>,
  ): Promise<T> => fn({}),
}));

const preDispatchTxClient = { query: vi.fn() };
vi.mock("@vex-agent/db/client.js", () => ({
  withTransaction: async <T>(fn: (client: unknown) => Promise<T>): Promise<T> =>
    fn(preDispatchTxClient),
}));

const mockHydrateEngineSession = vi.fn().mockResolvedValue(null);
vi.mock("@vex-agent/engine/core/hydrate.js", () => ({
  hydrateEngineSession: (...a: unknown[]) => mockHydrateEngineSession(...a),
  buildSessionWalletResolution: vi.fn(),
}));

const mockUpdateStatusIfNotTerminal = vi.fn().mockResolvedValue(true);
vi.mock("@vex-agent/db/repos/mission-runs.js", () => ({
  updateStatus: vi.fn(),
  updateStatusIfNotTerminal: (...a: unknown[]) =>
    mockUpdateStatusIfNotTerminal(...a),
}));

const mockClaimResumeContinuation = vi.fn();
const mockDiscardContinuation = vi.fn();
vi.mock("@vex-agent/engine/core/approval-runtime/continuation.js", () => ({
  claimResumeContinuation: (...a: unknown[]) =>
    mockClaimResumeContinuation(...a),
  discardContinuation: (...a: unknown[]) => mockDiscardContinuation(...a),
}));

vi.mock(
  "@vex-agent/engine/core/approval-runtime/deferred-resume.js",
  () => ({ scheduleDeferredResumeRetries: vi.fn() }),
);

const mockLoggerWarn = vi.fn();
const mockLoggerError = vi.fn();
vi.mock("@utils/logger.js", () => ({
  default: {
    info: vi.fn(),
    warn: (...a: unknown[]) => mockLoggerWarn(...a),
    error: (...a: unknown[]) => mockLoggerError(...a),
    debug: vi.fn(),
  },
}));

const { applyApproveSideEffects } = await import(
  "@vex-agent/engine/core/approval-runtime/post-tx/dispatch-approved.js"
);

const MISSION_RUN_ID = "run-1";

function approvedMissionSnapshot() {
  return {
    type: "approved_in_tx" as const,
    queueResolvedAt: "2026-07-28T00:00:00.000Z",
    row: {
      approval_id: "appr-1",
      session_id: "s1",
      mission_run_id: MISSION_RUN_ID,
      tool_call_id: null,
      queue_tool_call_id: "tc-1",
      queue_tool_call: { command: "kyberswap_swap", args: {} },
      queue_permission_at_enqueue: "restricted",
    },
  } as unknown as Parameters<typeof applyApproveSideEffects>[1];
}

/**
 * A CHAT-session approval: `mission_run_id` is null. Since session-scoped stop
 * became a first-class control request, the gate can legitimately return
 * `stopped` for one of these — which is precisely the case the old
 * `missionRunId !== null` guard let fall through to `dispatchTool`.
 */
function approvedChatSnapshot() {
  return {
    type: "approved_in_tx" as const,
    queueResolvedAt: "2026-07-28T00:00:00.000Z",
    row: {
      approval_id: "appr-1",
      session_id: "s1",
      mission_run_id: null,
      tool_call_id: null,
      queue_tool_call_id: "tc-1",
      queue_tool_call: { command: "kyberswap_swap", args: {} },
      queue_permission_at_enqueue: "restricted",
    },
  } as unknown as Parameters<typeof applyApproveSideEffects>[1];
}

beforeEach(() => {
  vi.clearAllMocks();
  mockHydrateEngineSession.mockResolvedValue(null);
  mockUpdateStatusIfNotTerminal.mockResolvedValue(true);
  mockCasMarkDispatching.mockResolvedValue(true);
  mockGateOnOperatorStopTransaction.mockResolvedValue({ kind: "clear" });
  mockPreDispatchGate.mockResolvedValue({ kind: "clear" });
  mockDispatchTool.mockResolvedValue({ success: true, output: "{}", data: {} });
  mockClaimResumeContinuation.mockResolvedValue({
    outcome: "claimed",
    continuation: {
      kind: "mission_run",
      missionRunId: MISSION_RUN_ID,
      sessionId: "s1",
      approvalId: "appr-1",
      ownerId: "approve-appr-1",
      leaseHandle: { release: vi.fn() },
    },
  });
});

describe("applyApproveSideEffects — operator-stop gate", () => {
  it("does NOT dispatch the approved tool when the operator stopped the run", async () => {
    mockPreDispatchGate.mockResolvedValue({
      kind: "stopped",
      runStatus: "stopped",
    });

    const outcome = await applyApproveSideEffects(
      "appr-1",
      approvedMissionSnapshot(),
    );

    // The whole point: real funds do not move after Stop.
    expect(mockDispatchTool).not.toHaveBeenCalled();
    expect(mockCommitApprovedToolResult).not.toHaveBeenCalled();
    expect(outcome).toEqual({
      kind: "run_terminated",
      approvalId: "appr-1",
      missionRunId: MISSION_RUN_ID,
      runStatus: "stopped",
    });
  });

  it("reports the run's REAL terminal status, never a literal", async () => {
    mockPreDispatchGate.mockResolvedValue({
      kind: "stopped",
      runStatus: "cancelled",
    });

    const outcome = await applyApproveSideEffects(
      "appr-1",
      approvedMissionSnapshot(),
    );

    if (outcome.kind !== "run_terminated") throw new Error("kind mismatch");
    expect(outcome.runStatus).toBe("cancelled");
  });

  it("settles the dispatching row with a structural, secret-free tool result", async () => {
    mockPreDispatchGate.mockResolvedValue({
      kind: "stopped",
      runStatus: "stopped",
    });

    await applyApproveSideEffects("appr-1", approvedMissionSnapshot());

    // Leaving the row in `dispatching` would make the reconciler declare an
    // `indeterminate` outcome for a tool that provably never ran.
    expect(mockCommitDispatchFailureToolResult).toHaveBeenCalledTimes(1);
    const call = mockCommitDispatchFailureToolResult.mock.calls[0]![0] as {
      approvalId: string;
      sessionId: string;
      toolCallId: string;
      content: string;
      errorHash: string;
    };
    expect(call.approvalId).toBe("appr-1");
    expect(call.toolCallId).toBe("tc-1");
    expect(call.content).toContain("operator_stop_before_dispatch");
    expect(call.errorHash).toMatch(/^[0-9a-f]+$/);
  });

  it("hands the lease back instead of leaking it until TTL", async () => {
    mockPreDispatchGate.mockResolvedValue({
      kind: "stopped",
      runStatus: "stopped",
    });

    await applyApproveSideEffects("appr-1", approvedMissionSnapshot());

    expect(mockDiscardContinuation).toHaveBeenCalledTimes(1);
  });

  it("ORDERING: gate and slot CAS share one locked tx, IMMEDIATELY BEFORE the dispatch", async () => {
    const order: string[] = [];
    mockAcquireSessionControlLock.mockImplementation(async () => {
      order.push("session_lock");
    });
    mockCasMarkDispatching.mockImplementation(async () => {
      order.push("cas");
      return true;
    });
    mockHydrateEngineSession.mockImplementation(async () => {
      order.push("build_context");
      return null;
    });
    mockPreDispatchGate.mockImplementation(async () => {
      order.push("gate");
      return { kind: "clear" };
    });
    mockGateOnOperatorStopTransaction.mockImplementation(async () => {
      order.push("post_dispatch_gate");
      return { kind: "clear" };
    });
    mockDispatchTool.mockImplementation(async () => {
      order.push("dispatch");
      return { success: true, output: "{}", data: {} };
    });

    mockCommitApprovedToolResult.mockImplementation(async () => {
      order.push("commit_result");
    });

    await applyApproveSideEffects("appr-1", approvedMissionSnapshot());

    // Context construction FIRST — it is a read and moves nothing, so it must
    // NOT sit between the gate and the call (an await there is a window in
    // which a committed Stop still permits a not-yet-started dispatch).
    //
    // Then ONE transaction: session control lock, gate, slot CAS. The CAS is
    // still what makes this dispatch publicly committed-to, so any Stop
    // inserted later necessarily sees `dispatching`; sharing the gate's
    // transaction removes the window in which it could sit between the two.
    // The gate precedes the CAS inside it because the global lock order puts
    // money-state rows last.
    //
    // Dispatch next, unlocked. Then the result is made durable, and only THEN
    // is a Stop that landed during the unlocked window applied — an executed
    // tool's outcome must never be lost to a stop that arrived after it.
    expect(order).toEqual([
      "build_context",
      "session_lock",
      "gate",
      "cas",
      "dispatch",
      "commit_result",
      "post_dispatch_gate",
    ]);
  });

  it("refuses a dispatch when the Stop commits DURING context construction", async () => {
    // The window ATROPOS-5 finding A closed: the gate used to complete before
    // the awaited context build, so a Stop committed in that window found the
    // dispatch already past its only check — and the tool had NOT started yet,
    // which is precisely the call the gate exists to refuse.
    let stopCommitted = false;
    mockHydrateEngineSession.mockImplementation(async () => {
      stopCommitted = true; // the operator presses Stop mid-hydration
      return null;
    });
    mockPreDispatchGate.mockImplementation(async () =>
      stopCommitted
        ? { kind: "stopped", runStatus: "stopped" }
        : { kind: "clear" },
    );

    const outcome = await applyApproveSideEffects(
      "appr-1",
      approvedMissionSnapshot(),
    );

    expect(mockDispatchTool).not.toHaveBeenCalled();
    expect(mockCommitApprovedToolResult).not.toHaveBeenCalled();
    expect(outcome.kind).toBe("run_terminated");
  });

  it("a clear gate leaves the normal dispatch path untouched", async () => {
    const outcome = await applyApproveSideEffects(
      "appr-1",
      approvedMissionSnapshot(),
    );

    expect(mockDispatchTool).toHaveBeenCalledTimes(1);
    expect(mockCommitApprovedToolResult).toHaveBeenCalledTimes(1);
    expect(mockCommitDispatchFailureToolResult).not.toHaveBeenCalled();
    expect(outcome.kind).toBe("dispatched");
  });

  it("a busy lease never reaches the gate — nothing has happened yet", async () => {
    mockClaimResumeContinuation.mockResolvedValue({ outcome: "busy" });

    const outcome = await applyApproveSideEffects(
      "appr-1",
      approvedMissionSnapshot(),
    );

    expect(outcome.kind).toBe("deferred_busy");
    expect(mockPreDispatchGate).not.toHaveBeenCalled();
    expect(mockCasMarkDispatching).not.toHaveBeenCalled();
    expect(mockDispatchTool).not.toHaveBeenCalled();
  });

  it("a lost slot CAS is observed in the SAME tx as the gate — another writer owns the dispatch", async () => {
    // The gate now runs before the CAS inside one transaction, so unlike the
    // old two-transaction shape it IS consulted here. What must not change is
    // the consequence: a lost CAS means another writer owns this dispatch and
    // the tool must not run a second time.
    mockCasMarkDispatching.mockResolvedValue(false);

    const outcome = await applyApproveSideEffects(
      "appr-1",
      approvedMissionSnapshot(),
    );

    expect(outcome.kind).toBe("deferred_busy");
    expect(mockPreDispatchGate).toHaveBeenCalledTimes(1);
    expect(mockDispatchTool).not.toHaveBeenCalled();
    expect(mockCommitApprovedToolResult).not.toHaveBeenCalled();
  });

  it("APPLIES a Stop that arrived DURING the dispatch, after committing the result", async () => {
    // INVERTED (ATROPOS-4 finding 2). This test previously pinned "records but
    // never acts": the queued Stop was logged and then abandoned. There is no
    // mission AbortController on this path, and the only thing that would have
    // applied the request is the resumed turn — which this very Stop means we
    // must not start. So the Stop was durably queued and durably ignored.
    //
    // Both halves of the in-flight rule still hold, and the ORDER is the point:
    // the executed call is not undone and its result is committed FIRST, then
    // the Stop lands and the continuation is suppressed. Nothing is
    // re-dispatched — applying a stop only settles state that already exists.
    const order: string[] = [];
    mockDispatchTool.mockImplementation(async () => {
      order.push("dispatch");
      return { success: true, output: "{}", data: {} };
    });
    mockCommitApprovedToolResult.mockImplementation(async () => {
      order.push("commit_result");
    });
    // Nothing is queued when the pre-dispatch gate runs; the Stop is inserted
    // while the unlocked dispatch runs, so the post-dispatch consumer sees it.
    mockPreDispatchGate.mockImplementation(async () => {
      order.push("gate");
      return { kind: "clear" };
    });
    mockGateOnOperatorStopTransaction.mockImplementation(async () => {
      order.push("post_dispatch_gate");
      return { kind: "stopped", runStatus: "stopped" };
    });

    const outcome = await applyApproveSideEffects(
      "appr-1",
      approvedMissionSnapshot(),
    );

    expect(order).toEqual([
      "gate",
      "dispatch",
      "commit_result",
      "post_dispatch_gate",
    ]);
    if (outcome.kind !== "dispatched") throw new Error("kind mismatch");
    // The tool ran and its result is durable — that fact outranks the Stop.
    expect(outcome.executionStatus).toBe("succeeded");
    expect(mockCommitApprovedToolResult).toHaveBeenCalledTimes(1);
    // …but the agent is NOT resumed onto a run the user just stopped, and the
    // lease is handed back rather than leaked.
    expect(outcome.continuation).toBeNull();
    expect(mockDiscardContinuation).toHaveBeenCalledTimes(1);
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      "engine.approval_runtime.stop_applied_after_dispatch",
      expect.objectContaining({ approvalId: "appr-1", runStatus: "stopped" }),
    );
  });

  it("a failing stop application is NOT treated as 'no stop queued'", async () => {
    // ATROPOS-5 finding B. This used to degrade to `clear` and hand the
    // continuation back — i.e. resume the agent — on the claim that the
    // reconciler and the iteration-entry guard were a durable backstop. They
    // are not: the ONLY reader of an open `stop_terminal` row is
    // `observeAndApplyControl`, called from the turn-loop iteration checkpoint,
    // which a run about to be parked never reaches. So a failure now means
    // "we could not find out", and the agent is not resumed on a guess.
    mockGateOnOperatorStopTransaction
      .mockRejectedValueOnce(new Error("db down"))
      .mockResolvedValue({ kind: "clear" });

    await expect(
      applyApproveSideEffects("appr-1", approvedMissionSnapshot()),
    ).rejects.toMatchObject({ errorKind: "operator_stop_apply_failed" });

    // The tool ran and its result stays durable — that is never sacrificed.
    expect(mockCommitApprovedToolResult).toHaveBeenCalledTimes(1);
    expect(mockDispatchTool).toHaveBeenCalledTimes(1);
    // The lease is handed back and the run is parked, so nothing proceeds.
    expect(mockDiscardContinuation).toHaveBeenCalledTimes(1);
    expect(mockUpdateStatusIfNotTerminal).toHaveBeenCalled();
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      "engine.approval_runtime.stop_apply_failed",
      expect.objectContaining({ approvalId: "appr-1" }),
    );
  });

  it("names an unresolved stop on the failure funnel instead of parking silently", async () => {
    mockDispatchTool.mockRejectedValue(new Error("tool blew up"));
    mockGateOnOperatorStopTransaction.mockRejectedValue(new Error("db down"));

    await expect(
      applyApproveSideEffects("appr-1", approvedMissionSnapshot()),
    ).rejects.toBeInstanceOf(Error);

    expect(mockLoggerError).toHaveBeenCalledWith(
      "engine.approval_runtime.stop_apply_unresolved",
      expect.objectContaining({ approvalId: "appr-1" }),
    );
  });
});

/**
 * THE SESSION-SCOPE HOLE (round-10 blocker 1, money-path).
 *
 * The gate branch used to read `stopGate.kind === "stopped" && missionRunId !==
 * null`, justified by a comment asserting that `stopped` was unreachable
 * without a run. That stopped being true the moment a session-scoped
 * `stop_terminal` became real: the gate now legitimately returns `stopped` for
 * a chat session, the `missionRunId !== null` half of the condition is false,
 * and control FELL THROUGH to `dispatchTool`.
 *
 * The consequence is the worst one available on this runtime: an approved
 * mutating tool — a swap, a transfer — executing after the operator pressed
 * Stop. Nothing else neutralised the slot, either: the intent is already
 * `dispatching`, and `applySessionStopWithClient` only rejects PENDING
 * approvals, so this row was invisible to the stop it should have obeyed.
 */
describe("applyApproveSideEffects — SESSION-scoped operator stop", () => {
  beforeEach(() => {
    mockClaimResumeContinuation.mockResolvedValue({
      outcome: "claimed",
      continuation: {
        kind: "chat_session",
        sessionId: "s1",
        approvalId: "appr-1",
        ownerId: "approve-appr-1",
        leaseHandle: { release: vi.fn() },
      },
    });
  });

  it("does NOT dispatch the approved tool when the SESSION was stopped", async () => {
    mockPreDispatchGate.mockResolvedValue({
      kind: "stopped",
      runStatus: "cancelled",
      scope: "session",
    });

    const outcome = await applyApproveSideEffects(
      "appr-1",
      approvedChatSnapshot(),
    );

    // The whole point: real funds do not move after Stop — on a chat session
    // exactly as on a mission run.
    expect(mockDispatchTool).not.toHaveBeenCalled();
    expect(mockCommitApprovedToolResult).not.toHaveBeenCalled();
    expect(outcome.kind).toBe("run_terminated");
  });

  it("settles the dispatching row structurally, so the reconciler cannot call it indeterminate", async () => {
    mockPreDispatchGate.mockResolvedValue({
      kind: "stopped",
      runStatus: "cancelled",
      scope: "session",
    });

    await applyApproveSideEffects("appr-1", approvedChatSnapshot());

    // The SAME settlement shape as the mission path — not a second one.
    expect(mockCommitDispatchFailureToolResult).toHaveBeenCalledTimes(1);
    const call = mockCommitDispatchFailureToolResult.mock.calls[0]![0] as {
      approvalId: string;
      toolCallId: string;
      content: string;
    };
    expect(call.approvalId).toBe("appr-1");
    expect(call.toolCallId).toBe("tc-1");
    expect(call.content).toContain("operator_stop_before_dispatch");
  });

  it("releases the chat continuation instead of leaking the session lease", async () => {
    mockPreDispatchGate.mockResolvedValue({
      kind: "stopped",
      runStatus: "cancelled",
      scope: "session",
    });

    await applyApproveSideEffects("appr-1", approvedChatSnapshot());

    expect(mockDiscardContinuation).toHaveBeenCalledTimes(1);
  });

  it("a CLEAR gate on a chat session still dispatches normally", async () => {
    mockGateOnOperatorStopTransaction.mockResolvedValue({ kind: "clear" });

    await applyApproveSideEffects("appr-1", approvedChatSnapshot());

    // The fix must not turn every chat approval into a refusal.
    expect(mockDispatchTool).toHaveBeenCalledTimes(1);
  });
});

/**
 * THE TWIN GAP (post-dispatch window).
 *
 * `applyQueuedOperatorStop` early-returned `clear` for a chat session on the
 * same false premise the pre-dispatch branch carried: that a stop could not
 * exist without a run. So a session stop queued WHILE an approved chat tool was
 * executing was never landed — the request stayed `pending`, the continuation
 * was handed back, and the agent resumed on a session the operator had stopped.
 *
 * Narrower than the pre-dispatch hole (the tool has already run, and that
 * outcome is legitimately durable — the in-flight rule), but the same class:
 * the durable consequence is a stopped session being resumed.
 */
describe("applyApproveSideEffects — SESSION stop queued DURING the dispatch", () => {
  beforeEach(() => {
    mockClaimResumeContinuation.mockResolvedValue({
      outcome: "claimed",
      continuation: {
        kind: "chat_session",
        sessionId: "s1",
        approvalId: "appr-1",
        ownerId: "approve-appr-1",
        leaseHandle: { release: vi.fn() },
      },
    });
  });

  it("lands the session stop and does NOT resume the agent", async () => {
    // Pre-dispatch gate: nothing queued yet, so the approved tool runs (the
    // beforeEach default). The operator presses Stop while it is in flight.
    mockGateOnOperatorStopTransaction.mockResolvedValueOnce({
      kind: "stopped",
      runStatus: "cancelled",
      scope: "session",
    });

    const outcome = await applyApproveSideEffects(
      "appr-1",
      approvedChatSnapshot(),
    );

    // The tool DID run and its result is durable — never undone.
    expect(mockDispatchTool).toHaveBeenCalledTimes(1);
    expect(mockCommitApprovedToolResult).toHaveBeenCalledTimes(1);
    expect(outcome.kind).toBe("dispatched");

    // THE POINT: the stop was consulted for the session (not skipped), and the
    // continuation was released instead of resuming the agent.
    expect(mockGateOnOperatorStopTransaction).toHaveBeenCalledTimes(1);
    expect(mockGateOnOperatorStopTransaction).toHaveBeenLastCalledWith({
      sessionId: "s1",
      missionRunId: null,
    });
    expect(mockDiscardContinuation).toHaveBeenCalledTimes(1);
  });

  it("a clear post-dispatch gate still resumes the chat session normally", async () => {
    mockGateOnOperatorStopTransaction.mockResolvedValue({ kind: "clear" });

    const outcome = await applyApproveSideEffects(
      "appr-1",
      approvedChatSnapshot(),
    );

    // The fix must not strand every chat approval's continuation.
    expect(outcome.kind).toBe("dispatched");
    expect(mockDiscardContinuation).not.toHaveBeenCalled();
  });

  it("NEVER THROWS: a gate failure is reported as apply_failed, never as clear", async () => {
    mockGateOnOperatorStopTransaction.mockRejectedValueOnce(
      new Error("db blip"),
    );

    // `apply_failed` on the post-dispatch path escalates to a post-decision
    // error rather than resuming on a guess — the contract is unchanged for a
    // chat session, which previously could not even reach it.
    await expect(
      applyApproveSideEffects("appr-1", approvedChatSnapshot()),
    ).rejects.toThrow(/operator_stop_apply_failed/);

    // The committed result survives the escalation.
    expect(mockCommitApprovedToolResult).toHaveBeenCalledTimes(1);
  });
});
