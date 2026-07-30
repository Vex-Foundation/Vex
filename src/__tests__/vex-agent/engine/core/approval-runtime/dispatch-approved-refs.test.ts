/**
 * Caller-level: `applyApproveSideEffects` derives explorer refs from the
 * approved dispatch's `result.data` (capture-shaped) and PASSES them to
 * `commitApprovedToolResult` — the derivation happens at the caller, not by
 * injecting refs into the sink. Approval-gated financial actions are the most
 * important case for a validated tx link, so this pins the wiring end to end.
 *
 * `missionRunId` is null (chat session), which since the lifecycle work means a
 * CHAT continuation is claimed rather than none at all — the whole point of the
 * fix. The claim is stubbed as successful so this test stays about ref
 * derivation; `prepare-approve.test.ts` owns the ordering contract.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockCommitApprovedToolResult = vi.fn();
vi.mock(
  "@vex-agent/engine/core/approval-runtime/post-tx/result-message.js",
  () => ({
    commitApprovedToolResult: (...a: unknown[]) =>
      mockCommitApprovedToolResult(...a),
    commitDispatchFailureToolResult: vi.fn(),
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

vi.mock("@vex-agent/engine/core/hydrate.js", () => ({
  hydrateEngineSession: vi.fn().mockResolvedValue(null),
  buildSessionWalletResolution: vi.fn(),
}));

const mockClaimResumeContinuation = vi.fn();
vi.mock("@vex-agent/engine/core/approval-runtime/continuation.js", () => ({
  claimResumeContinuation: (...a: unknown[]) =>
    mockClaimResumeContinuation(...a),
  discardContinuation: vi.fn(),
}));

vi.mock(
  "@vex-agent/engine/core/approval-runtime/deferred-resume.js",
  () => ({ scheduleDeferredResumeRetries: vi.fn() }),
);

/**
 * The approved-dispatch stop gate. A chat session (`missionRunId: null`) used to
 * short-circuit to `clear` WITHOUT opening a transaction, on the reasoning that
 * `stop_terminal` was run-scoped so there was nothing to observe. That is no
 * longer true: a session-scoped stop is a real row now, so this gate opens a
 * transaction for a chat session too — an approved money-path dispatch must not
 * proceed after the operator stopped the session. Mocked `clear` here so this
 * file stays about ref derivation.
 */
const mockGateOnOperatorStopTransaction = vi.fn().mockResolvedValue({
  kind: "clear",
});
vi.mock("@vex-agent/db/client.js", () => ({
  // The pre-dispatch transaction (stop gate + slot CAS) is the only DB work
  // this file's subject opens directly; both of its statements are mocked
  // above, so the client is an inert stand-in.
  withTransaction: async <T>(fn: (client: unknown) => Promise<T>): Promise<T> =>
    fn({ query: vi.fn() }),
}));

vi.mock("@vex-agent/engine/runtime/lease-and-status.js", () => ({
  gateOnOperatorStopWithClient: async () => ({ kind: "clear" }),
  acquireSessionControlLock: vi.fn(),
  gateOnOperatorStopTransaction: (...a: unknown[]) =>
    mockGateOnOperatorStopTransaction(...a),
}));

vi.mock("@utils/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { applyApproveSideEffects } = await import(
  "@vex-agent/engine/core/approval-runtime/post-tx/dispatch-approved.js"
);

function approvedSnapshot() {
  return {
    type: "approved_in_tx" as const,
    queueResolvedAt: "2026-07-13T00:00:00.000Z",
    row: {
      approval_id: "appr-1",
      session_id: "s1",
      mission_run_id: null,
      tool_call_id: null,
      queue_tool_call_id: "tc-1",
      queue_tool_call: { command: "kyberswap_swap", args: {} },
      queue_permission_at_enqueue: "full",
    },
  } as unknown as Parameters<typeof applyApproveSideEffects>[1];
}

beforeEach(() => {
  vi.clearAllMocks();
  mockCasMarkDispatching.mockResolvedValue(true);
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

describe("applyApproveSideEffects — explorer ref derivation", () => {
  it("derives refs from the coherent capture and passes them to the commit", async () => {
    mockDispatchTool.mockResolvedValue({
      success: true,
      output: "{}",
      data: {
        txHash: "0xtop", // top-level hash deliberately NOT paired
        _tradeCapture: { chain: "hyperliquid", txHash: "0xdead", walletAddress: "0xw" },
      },
    });

    const outcome = await applyApproveSideEffects("appr-1", approvedSnapshot());

    expect(outcome.kind).toBe("dispatched");
    const call = mockCommitApprovedToolResult.mock.calls[0]![0] as {
      sessionId: string;
      toolCallId: string;
      explorerRefs: unknown;
    };
    expect(call.sessionId).toBe("s1");
    expect(call.toolCallId).toBe("tc-1");
    // Coherent chain+txRef from the capture.
    expect(call.explorerRefs).toEqual([
      { chain: "hyperliquid", txRef: "0xdead" },
    ]);
  });

  it("passes empty refs when the dispatch result carries no capture", async () => {
    mockDispatchTool.mockResolvedValue({ success: true, output: "{}", data: {} });

    await applyApproveSideEffects("appr-1", approvedSnapshot());

    const call = mockCommitApprovedToolResult.mock.calls[0]![0] as {
      explorerRefs: unknown;
    };
    expect(call.explorerRefs).toEqual([]);
  });

  it("a chat session now carries a continuation (the resume fix)", async () => {
    mockDispatchTool.mockResolvedValue({ success: true, output: "{}", data: {} });

    const outcome = await applyApproveSideEffects("appr-1", approvedSnapshot());

    if (outcome.kind !== "dispatched") throw new Error("kind mismatch");
    expect(outcome.missionRunId).toBeNull();
    expect(outcome.continuation).not.toBeNull();
    expect(outcome.continuation?.kind).toBe("chat_session");
  });
});
