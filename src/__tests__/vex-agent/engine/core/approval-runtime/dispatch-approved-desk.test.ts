/**
 * The desk lane's approve half (migration 164): a `desk` row dispatches
 * through the same slot gate and the same `dispatchTool` as an agent row, but
 * writes no transcript tool result, claims no continuation, and settles
 * through `commitDeskSettlementWith`. Its outcome rides the approve reply.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { IntentSnapshotRow } from "@vex-agent/engine/core/approval-runtime/snapshot/types.js";

const mockCommitApprovedToolResult = vi.fn();
const mockCommitDispatchFailureToolResult = vi.fn();
vi.mock(
  "@vex-agent/engine/core/approval-runtime/post-tx/result-message.js",
  () => ({
    commitApprovedToolResult: (...a: unknown[]) => mockCommitApprovedToolResult(...a),
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
const mockCommitDeskSettlement = vi.fn().mockResolvedValue(true);
const mockGetByApprovalId = vi.fn();
vi.mock("@vex-agent/db/repos/approval-intents.js", () => ({
  markExecutionStatus: vi.fn(),
  casMarkDispatchingWith: (...a: unknown[]) => mockCasMarkDispatching(...a),
  commitDeskSettlementWith: (...a: unknown[]) => mockCommitDeskSettlement(...a),
  getByApprovalId: (...a: unknown[]) => mockGetByApprovalId(...a),
}));

const mockRegisterDeskSettlementRepair = vi.fn();
vi.mock(
  "@vex-agent/engine/core/approval-runtime/desk/repair-registry.js",
  () => ({
    registerDeskSettlementRepair: (...a: unknown[]) =>
      mockRegisterDeskSettlementRepair(...a),
  }),
);

const mockPreDispatchGate = vi.fn();
vi.mock("@vex-agent/engine/runtime/lease-and-status.js", () => ({
  gateOnOperatorStopTransaction: vi.fn().mockResolvedValue({ kind: "clear" }),
  gateOnOperatorStopWithClient: (...a: unknown[]) => mockPreDispatchGate(...a),
  acquireSessionControlLock: vi.fn(),
  withSessionControlLock: async <T>(
    _sessionId: string,
    fn: (client: unknown) => Promise<T>,
  ): Promise<T> => fn({}),
}));

vi.mock("@vex-agent/db/client.js", () => ({
  withTransaction: async <T>(fn: (client: unknown) => Promise<T>): Promise<T> =>
    fn({ query: vi.fn() }),
}));

vi.mock("@vex-agent/engine/core/hydrate.js", () => ({
  hydrateEngineSession: vi.fn().mockResolvedValue(null),
  buildSessionWalletResolution: vi.fn(),
}));

const mockClaimResumeContinuation = vi.fn();
vi.mock("@vex-agent/engine/core/approval-runtime/continuation.js", () => ({
  claimResumeContinuation: (...a: unknown[]) => mockClaimResumeContinuation(...a),
  discardContinuation: vi.fn(),
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
const { resetDeskApprovalDispatchesForTests } = await import(
  "@vex-agent/engine/core/approval-runtime/desk/dispatch-flight.js"
);

function deskSnapshot() {
  const row: IntentSnapshotRow = {
    approval_id: "appr-desk",
    session_id: "s1",
    mission_run_id: null,
    tool_call_id: null,
    expires_at: null,
    preview_json: null,
    decision: "approved",
    decision_reason: null,
    decided_at: "2026-09-18T00:00:00.000Z",
    execution_status: "not_started",
    execution_result_hash: null,
    origin: "desk",
    project_id: null,
    scope_version_at_enqueue: null,
    request_digest: null,
    queue_status: "resolved",
    queue_resolved_at: "2026-09-18T00:00:00.000Z",
    queue_created_at: "2026-09-18T00:00:00.000Z",
    queue_tool_call: {
      command: "execute_tool",
      args: { toolId: "lighter.position.close", params: { intentId: "x" } },
    },
    queue_tool_call_id: "tc-desk",
    queue_permission_at_enqueue: "restricted",
    session_permission_live: "restricted",
  };
  return {
    type: "approved_in_tx" as const,
    queueResolvedAt: "2026-09-18T00:00:00.000Z",
    row,
  } satisfies Parameters<typeof applyApproveSideEffects>[1];
}

beforeEach(() => {
  vi.clearAllMocks();
  resetDeskApprovalDispatchesForTests();
  mockCasMarkDispatching.mockResolvedValue(true);
  mockCommitDeskSettlement.mockResolvedValue(true);
  mockGetByApprovalId.mockResolvedValue(null);
  mockPreDispatchGate.mockResolvedValue({ kind: "clear" });
  mockDispatchTool.mockResolvedValue({ success: true, output: "{\"ok\":true}", data: {} });
});

describe("applyApproveSideEffects - desk origin", () => {
  it("dispatches the stored call and settles the row without touching the transcript", async () => {
    const outcome = await applyApproveSideEffects("appr-desk", deskSnapshot());

    expect(mockClaimResumeContinuation).not.toHaveBeenCalled();
    expect(mockDispatchTool).toHaveBeenCalledTimes(1);
    const dispatchCall = mockDispatchTool.mock.calls[0];
    if (!dispatchCall) throw new Error("expected dispatch call");
    expect(dispatchCall[0]).toEqual({
      name: "execute_tool",
      args: { toolId: "lighter.position.close", params: { intentId: "x" } },
      toolCallId: "tc-desk",
    });
    expect(mockCommitApprovedToolResult).not.toHaveBeenCalled();
    expect(mockCommitDispatchFailureToolResult).not.toHaveBeenCalled();
    expect(mockCommitDeskSettlement).toHaveBeenCalledTimes(1);
    const settlementCall = mockCommitDeskSettlement.mock.calls[0];
    if (!settlementCall) throw new Error("expected settlement call");
    expect(settlementCall[1]).toMatchObject({
      approvalId: "appr-desk",
      status: "succeeded",
    });
    expect(outcome).toMatchObject({
      kind: "dispatched",
      approvalId: "appr-desk",
      executionStatus: "succeeded",
      missionRunId: null,
      continuation: null,
      toolResult: { success: true, output: "{\"ok\":true}" },
    });
  });

  it("does NOT dispatch after an operator stop and settles the row as failed", async () => {
    mockPreDispatchGate.mockResolvedValue({ kind: "stopped", runStatus: "stopped" });

    const outcome = await applyApproveSideEffects("appr-desk", deskSnapshot());

    expect(mockDispatchTool).not.toHaveBeenCalled();
    const settlementCall = mockCommitDeskSettlement.mock.calls[0];
    if (!settlementCall) throw new Error("expected settlement call");
    expect(settlementCall[1]).toMatchObject({ status: "failed" });
    expect(outcome).toMatchObject({ kind: "dispatched", executionStatus: "failed" });
  });

  it("marks a dispatch that threw as indeterminate, never retried", async () => {
    mockDispatchTool.mockRejectedValue(new Error("socket hang up"));

    const outcome = await applyApproveSideEffects("appr-desk", deskSnapshot());

    expect(mockDispatchTool).toHaveBeenCalledTimes(1);
    const settlementCall = mockCommitDeskSettlement.mock.calls[0];
    if (!settlementCall) throw new Error("expected settlement call");
    expect(settlementCall[1]).toMatchObject({ status: "indeterminate" });
    expect(outcome).toMatchObject({
      kind: "dispatched",
      executionStatus: "indeterminate",
      toolResult: { success: false },
    });
    if (outcome.kind !== "dispatched") throw new Error("kind mismatch");
    expect(outcome.toolResult.output).not.toContain("socket hang up");
  });

  it("carries a failed handler output back to the desk", async () => {
    mockDispatchTool.mockResolvedValue({ success: false, output: "Order rejected: too small." });

    const outcome = await applyApproveSideEffects("appr-desk", deskSnapshot());

    const settlementCall = mockCommitDeskSettlement.mock.calls[0];
    if (!settlementCall) throw new Error("expected settlement call");
    expect(settlementCall[1]).toMatchObject({ status: "failed" });
    expect(outcome).toMatchObject({
      kind: "dispatched",
      executionStatus: "failed",
      toolResult: { success: false, output: "Order rejected: too small." },
    });
  });

  it("registers a write-only repair when both post-dispatch settlement writes fail", async () => {
    mockCommitDeskSettlement.mockRejectedValue(new Error("db unavailable"));

    const outcome = await applyApproveSideEffects("appr-desk", deskSnapshot());

    expect(mockDispatchTool).toHaveBeenCalledTimes(1);
    expect(mockCommitDeskSettlement).toHaveBeenCalledTimes(2);
    expect(mockRegisterDeskSettlementRepair).toHaveBeenCalledWith({
      approvalId: "appr-desk",
      resultHash: expect.any(String),
    });
    expect(outcome).toMatchObject({
      kind: "dispatched",
      executionStatus: "indeterminate",
    });
  });

  it("makes a concurrent CAS loser join the winner's terminal result and tool output", async () => {
    let finishDispatch: ((value: { success: true; output: string }) => void) | undefined;
    mockDispatchTool.mockImplementation(() => new Promise((resolve) => {
      finishDispatch = resolve;
    }));

    const winner = applyApproveSideEffects("appr-desk", deskSnapshot());
    await vi.waitFor(() => expect(mockDispatchTool).toHaveBeenCalledTimes(1));
    const loser = applyApproveSideEffects("appr-desk", deskSnapshot());

    finishDispatch?.({ success: true, output: "Order 77 filled." });
    const [winnerOutcome, loserOutcome] = await Promise.all([winner, loser]);

    expect(mockCasMarkDispatching).toHaveBeenCalledTimes(1);
    expect(mockDispatchTool).toHaveBeenCalledTimes(1);
    expect(mockCommitDeskSettlement).toHaveBeenCalledTimes(1);
    expect(loserOutcome).toEqual(winnerOutcome);
    expect(loserOutcome).toMatchObject({
      kind: "dispatched",
      executionStatus: "succeeded",
      toolResult: { success: true, output: "Order 77 filled." },
    });
  });
});
