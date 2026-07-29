/**
 * The money-path wiring of B2(c): an approved MUTATING tool must not execute
 * after the operator pressed Stop.
 *
 * Scope note, so the next session does not over-trust this file. What is
 * proven HERE is the wiring and the ordering inside `applyApproveSideEffects`:
 * that the gate runs AFTER the dispatch-slot CAS and BEFORE `dispatchTool`,
 * that a `stopped` verdict suppresses the dispatch entirely, that the
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
  casMarkDispatching: (...a: unknown[]) => mockCasMarkDispatching(...a),
}));

const mockGateOnOperatorStopTransaction = vi.fn();
vi.mock("@vex-agent/engine/runtime/lease-and-status.js", () => ({
  gateOnOperatorStopTransaction: (...a: unknown[]) =>
    mockGateOnOperatorStopTransaction(...a),
  // The `paused_error` recovery flip carries the durable operator-Stop consumer,
  // so it reaches the control plane too. Stubbed to "no stop raced us"; the
  // consumer's own behaviour is pinned by
  // `approval-runtime/paused-error-flip-stop-consumer.test.ts`.
  gateOnOperatorStopWithClient: async () => ({ kind: "clear" }),
  withSessionControlLock: async <T>(
    _sessionId: string,
    fn: (client: unknown) => Promise<T>,
  ): Promise<T> => fn({}),
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

beforeEach(() => {
  vi.clearAllMocks();
  mockHydrateEngineSession.mockResolvedValue(null);
  mockUpdateStatusIfNotTerminal.mockResolvedValue(true);
  mockCasMarkDispatching.mockResolvedValue(true);
  mockGateOnOperatorStopTransaction.mockResolvedValue({ kind: "clear" });
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
    mockGateOnOperatorStopTransaction.mockResolvedValue({
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
    mockGateOnOperatorStopTransaction.mockResolvedValue({
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
    mockGateOnOperatorStopTransaction.mockResolvedValue({
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
    mockGateOnOperatorStopTransaction.mockResolvedValue({
      kind: "stopped",
      runStatus: "stopped",
    });

    await applyApproveSideEffects("appr-1", approvedMissionSnapshot());

    expect(mockDiscardContinuation).toHaveBeenCalledTimes(1);
  });

  it("ORDERING: the gate runs AFTER the slot CAS and IMMEDIATELY BEFORE the dispatch", async () => {
    const order: string[] = [];
    mockCasMarkDispatching.mockImplementation(async () => {
      order.push("cas");
      return true;
    });
    mockHydrateEngineSession.mockImplementation(async () => {
      order.push("build_context");
      return null;
    });
    mockGateOnOperatorStopTransaction.mockImplementation(async () => {
      order.push("gate");
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

    // CAS first: the commit that makes this dispatch publicly committed-to, so
    // any Stop inserted later necessarily sees `dispatching`. Context
    // construction second — it is a read and moves nothing, so it must NOT sit
    // between the gate and the call (an await there is a window in which a
    // committed Stop still permits a not-yet-started dispatch). Gate third,
    // adjacent to the dispatch. Dispatch fourth, unlocked. Then the result is
    // made durable, and only THEN is a Stop that landed during the unlocked
    // window applied — an executed tool's outcome must never be lost to a stop
    // that arrived after it.
    expect(order).toEqual([
      "cas",
      "build_context",
      "gate",
      "dispatch",
      "commit_result",
      "gate",
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
    mockGateOnOperatorStopTransaction.mockImplementation(async () =>
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
    expect(mockGateOnOperatorStopTransaction).not.toHaveBeenCalled();
    expect(mockDispatchTool).not.toHaveBeenCalled();
  });

  it("a lost slot CAS never reaches the gate — another writer owns the dispatch", async () => {
    mockCasMarkDispatching.mockResolvedValue(false);

    const outcome = await applyApproveSideEffects(
      "appr-1",
      approvedMissionSnapshot(),
    );

    expect(outcome.kind).toBe("deferred_busy");
    expect(mockGateOnOperatorStopTransaction).not.toHaveBeenCalled();
    expect(mockDispatchTool).not.toHaveBeenCalled();
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
    mockGateOnOperatorStopTransaction.mockImplementation(async () => {
      // First call is the pre-dispatch gate (nothing queued yet); the Stop is
      // inserted while the unlocked dispatch runs, so the second call sees it.
      order.push("gate");
      return order.filter((s) => s === "gate").length === 1
        ? { kind: "clear" }
        : { kind: "stopped", runStatus: "stopped" };
    });

    const outcome = await applyApproveSideEffects(
      "appr-1",
      approvedMissionSnapshot(),
    );

    expect(order).toEqual(["gate", "dispatch", "commit_result", "gate"]);
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
      .mockResolvedValueOnce({ kind: "clear" })
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
    mockGateOnOperatorStopTransaction
      .mockResolvedValueOnce({ kind: "clear" })
      .mockRejectedValue(new Error("db down"));

    await expect(
      applyApproveSideEffects("appr-1", approvedMissionSnapshot()),
    ).rejects.toBeInstanceOf(Error);

    expect(mockLoggerError).toHaveBeenCalledWith(
      "engine.approval_runtime.stop_apply_unresolved",
      expect.objectContaining({ approvalId: "appr-1" }),
    );
  });
});
