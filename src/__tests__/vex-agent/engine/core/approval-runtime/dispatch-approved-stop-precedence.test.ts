/**
 * ATROPOS-4 finding 2: a terminal user Stop outranks `paused_error` on EVERY
 * failure exit of `applyApproveSideEffects`.
 *
 * The pre-dispatch gate only proves nothing was stopped BEFORE the tool left
 * the runtime. Everything after it runs unlocked, and this path has no mission
 * `AbortController` — so a Stop queued in that window used to be logged and
 * then abandoned, because the only thing that would have applied it is a
 * resumed turn that a failure exit never reaches. The run parked in
 * `paused_error`, offering `/retry` on a run the user had already stopped,
 * with their Stop still sitting unapplied in the queue.
 *
 * These tests assert STATE, not call shape. A fake `mission_runs` row carries
 * the real terminal-immutable semantics (`updateStatusIfNotTerminal` is a CAS;
 * a terminal row refuses further parking), and the stop gate mutates it the way
 * the shared stop transaction does. Whatever the module's internal structure
 * becomes, the row must read `stopped` / `user_stopped` at the end and the
 * dispatch's own outcome must already be durable when it does.
 *
 * Two orderings are load-bearing and both are pinned here:
 *   1. the dispatch RESULT is committed BEFORE the Stop is applied — the tool
 *      may have moved real funds and that fact must survive;
 *   2. the Stop is applied BEFORE any `paused_error` parking decision.
 * Nothing is ever re-dispatched.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

interface FakeRunRow {
  status: string;
  stopReason: string | null;
}

const TERMINAL = new Set(["completed", "failed", "stopped", "cancelled"]);

const runRow: FakeRunRow = { status: "paused_approval", stopReason: null };
/** Whether the operator has queued a `stop_terminal` for this run. */
let stopQueued = false;
const order: string[] = [];

const mockCommitApprovedToolResult = vi.fn(async () => {
  order.push("commit_result");
});
const mockCommitDispatchFailureToolResult = vi.fn(async () => {
  order.push("commit_failure_result");
});
vi.mock(
  "@vex-agent/engine/core/approval-runtime/post-tx/result-message.js",
  () => ({
    commitApprovedToolResult: (...a: unknown[]) =>
      mockCommitApprovedToolResult(...(a as [])),
    commitDispatchFailureToolResult: (...a: unknown[]) =>
      mockCommitDispatchFailureToolResult(...(a as [])),
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

/** The repo CAS: a terminal run row is immutable audit history. */
const mockUpdateStatusIfNotTerminal = vi.fn(
  async (_id: string, status: string, stopReason?: string) => {
    order.push("park_paused_error");
    if (TERMINAL.has(runRow.status)) return false;
    runRow.status = status;
    runRow.stopReason = stopReason ?? runRow.stopReason;
    return true;
  },
);
const mockUpdateStatus = vi.fn();
vi.mock("@vex-agent/db/repos/mission-runs.js", () => ({
  updateStatus: (...a: unknown[]) => mockUpdateStatus(...a),
  updateStatusIfNotTerminal: (...a: [string, string, string?]) =>
    mockUpdateStatusIfNotTerminal(...a),
}));

/**
 * Stands in for `gateOnOperatorStopTransaction`, which both OBSERVES and
 * APPLIES through the one shared stop body — so a queued stop leaves the
 * canonical `stopped` / `user_stopped` pair behind, exactly like the real one.
 */
/**
 * Both gates share ONE body, because in production they are the same shared
 * stop body — the pre-dispatch one now runs on the caller's client (it shares
 * a transaction with the slot CAS), the failure-exit consumer opens its own.
 * They are logged under distinct labels so the ordering assertions can tell
 * which of the two ran.
 */
function applyStopGate() {
  if (TERMINAL.has(runRow.status)) {
    return { kind: "stopped" as const, runStatus: runRow.status };
  }
  if (!stopQueued) return { kind: "clear" as const };
  runRow.status = "stopped";
  runRow.stopReason = "user_stopped";
  return { kind: "stopped" as const, runStatus: "stopped" };
}

/**
 * The label for the PRE-dispatch step is taken from the lock acquisition, not
 * from the gate: `flipRunToPausedError` consumes the same
 * `gateOnOperatorStopWithClient` on the failure exit, but reaches it through
 * `withSessionControlLock`. Only `dispatch-slot-gate.ts` acquires the lock on
 * its own transaction, so this is the one unambiguous marker for it.
 */
const mockAcquireSessionControlLock = vi.fn(async (..._args: unknown[]) => {
  order.push("pre_dispatch_stop_gate");
});
const mockGateOnOperatorStopTransaction = vi.fn(async () => {
  order.push("stop_gate");
  return applyStopGate();
});
vi.mock("@vex-agent/db/client.js", () => ({
  // The pre-dispatch transaction (stop gate + slot CAS) is the only DB work
  // this file's subject opens directly; both of its statements are mocked
  // above, so the client is an inert stand-in.
  withTransaction: async <T>(fn: (client: unknown) => Promise<T>): Promise<T> =>
    fn({ query: vi.fn() }),
}));

vi.mock("@vex-agent/engine/runtime/lease-and-status.js", () => ({
  acquireSessionControlLock: (...a: unknown[]) =>
    mockAcquireSessionControlLock(...a),
  gateOnOperatorStopTransaction: () => mockGateOnOperatorStopTransaction(),
  // Consumed by BOTH the pre-dispatch slot gate and `flipRunToPausedError`.
  // Stubbed `clear`: in every case in this file the stop is queued during or
  // after the dispatch, so the pre-dispatch gate is legitimately clear, and the
  // recovery flip must still reach its CAS to prove the CAS is what refuses it.
  // A `stopped` pre-dispatch verdict is pinned in
  // `dispatch-approved-stop-gate.test.ts`.
  gateOnOperatorStopWithClient: async () => ({ kind: "clear" }),
  // The `paused_error` recovery flip carries the durable operator-Stop consumer,
  // so it reaches the control plane too. Stubbed to "no stop raced us"; the
  // consumer's own behaviour is pinned by
  // `approval-runtime/paused-error-flip-stop-consumer.test.ts`.
  withSessionControlLock: async <T>(
    _sessionId: string,
    fn: (client: unknown) => Promise<T>,
  ): Promise<T> => fn({}),
}));

vi.mock("@vex-agent/engine/core/hydrate.js", () => ({
  hydrateEngineSession: vi.fn().mockResolvedValue(null),
  buildSessionWalletResolution: vi.fn(),
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

vi.mock("@utils/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { applyApproveSideEffects } = await import(
  "@vex-agent/engine/core/approval-runtime/post-tx/dispatch-approved.js"
);
const { ApprovalDispatchError, ApprovalPostDecisionError } = await import(
  "@vex-agent/engine/core/approval-runtime/types.js"
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
  order.length = 0;
  runRow.status = "paused_approval";
  runRow.stopReason = null;
  stopQueued = false;
  mockCasMarkDispatching.mockResolvedValue(true);
  mockDispatchTool.mockImplementation(async () => {
    order.push("dispatch");
    return { success: true, output: "{}", data: {} };
  });
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

describe("applyApproveSideEffects — terminal stop outranks paused_error", () => {
  it("dispatch THROWS after a queued Stop → run ends stopped, result still durable", async () => {
    mockDispatchTool.mockImplementation(async () => {
      order.push("dispatch");
      // The operator presses Stop while the unlocked dispatch is in flight.
      stopQueued = true;
      throw new TypeError("network down");
    });

    await expect(
      applyApproveSideEffects("appr-1", approvedMissionSnapshot()),
    ).rejects.toBeInstanceOf(ApprovalDispatchError);

    // The user's Stop is the run's terminal state — NOT `paused_error`, which
    // would offer `/retry` on a run they already stopped.
    expect(runRow.status).toBe("stopped");
    expect(runRow.stopReason).toBe("user_stopped");
    // The tool MAY have run, so the structural failure row is committed first
    // and the parking attempt comes last, where the CAS refuses it.
    expect(mockCommitDispatchFailureToolResult).toHaveBeenCalledTimes(1);
    expect(order).toEqual([
      "pre_dispatch_stop_gate",
      "dispatch",
      "commit_failure_result",
      "stop_gate",
      "park_paused_error",
    ]);
    // Nothing is ever re-dispatched.
    expect(mockDispatchTool).toHaveBeenCalledTimes(1);
  });

  it("resume preflight fails after a queued Stop → run ends stopped, nothing dispatched", async () => {
    stopQueued = true;
    mockClaimResumeContinuation.mockResolvedValue({ outcome: "status_mismatch" });

    await expect(
      applyApproveSideEffects("appr-1", approvedMissionSnapshot()),
    ).rejects.toBeInstanceOf(ApprovalPostDecisionError);

    expect(runRow.status).toBe("stopped");
    expect(runRow.stopReason).toBe("user_stopped");
    expect(mockDispatchTool).not.toHaveBeenCalled();
    // Stop applied BEFORE the parking decision, which the CAS then refuses.
    expect(order).toEqual(["stop_gate", "park_paused_error"]);
  });

  it("result persistence fails after a queued Stop → run ends stopped", async () => {
    mockDispatchTool.mockImplementation(async () => {
      order.push("dispatch");
      stopQueued = true;
      return { success: true, output: "{}", data: {} };
    });
    mockCommitApprovedToolResult.mockImplementation(async () => {
      order.push("commit_result");
      throw new Error("transcript pg connection lost");
    });

    await expect(
      applyApproveSideEffects("appr-1", approvedMissionSnapshot()),
    ).rejects.toBeInstanceOf(ApprovalPostDecisionError);

    expect(runRow.status).toBe("stopped");
    expect(runRow.stopReason).toBe("user_stopped");
    expect(order).toEqual([
      "pre_dispatch_stop_gate",
      "dispatch",
      "commit_result",
      "stop_gate",
      "park_paused_error",
    ]);
  });

  it("the lease is released only AFTER the terminal status is written", async () => {
    mockDispatchTool.mockImplementation(async () => {
      stopQueued = true;
      throw new TypeError("network down");
    });
    mockDiscardContinuation.mockImplementation(async () => {
      order.push("discard_continuation");
    });

    await expect(
      applyApproveSideEffects("appr-1", approvedMissionSnapshot()),
    ).rejects.toBeInstanceOf(ApprovalDispatchError);

    // Releasing first would publish a stale non-terminal status to the
    // renderer moments before the row goes terminal.
    expect(order.indexOf("discard_continuation")).toBeGreaterThan(
      order.indexOf("park_paused_error"),
    );
    expect(mockDiscardContinuation).toHaveBeenCalledTimes(1);
  });

  it("CONTROL: with no Stop queued, a dispatch throw still parks paused_error", async () => {
    // The precedence rule must not turn ordinary recovery into a no-op.
    mockDispatchTool.mockImplementation(async () => {
      throw new TypeError("network down");
    });

    await expect(
      applyApproveSideEffects("appr-1", approvedMissionSnapshot()),
    ).rejects.toBeInstanceOf(ApprovalDispatchError);

    expect(runRow.status).toBe("paused_error");
    expect(runRow.stopReason).toBe("approval_post_decision");
  });

  it("a chat session consults BOTH gates and still reports the dispatch failure", async () => {
    const chatSnapshot = {
      ...approvedMissionSnapshot(),
      row: {
        ...(approvedMissionSnapshot() as unknown as { row: Record<string, unknown> }).row,
        mission_run_id: null,
      },
    } as unknown as Parameters<typeof applyApproveSideEffects>[1];
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
    mockDispatchTool.mockImplementation(async () => {
      throw new TypeError("network down");
    });

    await expect(
      applyApproveSideEffects("appr-1", chatSnapshot),
    ).rejects.toBeInstanceOf(ApprovalDispatchError);

    // CONTRACT CHANGE (round 10). A chat session HAS something to stop now: a
    // session-scoped `stop_terminal`. Both gates therefore run — the step-2b
    // gate before the dispatch, and the failure-exit consumer after it, which
    // lands a Stop queued while the tool was in flight. Skipping the second one
    // was the gap that let an agent resume on a stopped session.
    //
    // There is still nothing to PARK: `flipRunToPausedError` needs a run row and
    // is correctly not reached (asserted below).
    // (This file's gate stub takes no args by design — that the session-scoped
    // call carries `missionRunId: null` is asserted in
    // `dispatch-approved-stop-gate.test.ts`.)
    expect(mockAcquireSessionControlLock).toHaveBeenCalledTimes(1);
    expect(mockGateOnOperatorStopTransaction).toHaveBeenCalledTimes(1);
    expect(mockUpdateStatusIfNotTerminal).not.toHaveBeenCalled();
    expect(mockCommitDispatchFailureToolResult).toHaveBeenCalledTimes(1);
  });
});
