/**
 * Caller-level: `applyApproveSideEffects` derives explorer refs from the
 * approved dispatch's `result.data` (capture-shaped) and PASSES them to
 * `appendApprovedToolResult` — the derivation happens at the caller, not by
 * injecting refs into the sink. Approval-gated financial actions are the most
 * important case for a validated tx link, so this pins the wiring end to end.
 *
 * `missionRunId` is null so the continuation-claim branch is skipped; the test
 * asserts only the ref derivation + hand-off.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockAppendApprovedToolResult = vi.fn();
const mockMarkApprovedExecutionStatus = vi.fn();
vi.mock(
  "@vex-agent/engine/core/approval-runtime/post-tx/result-message.js",
  () => ({
    appendApprovedToolResult: (...a: unknown[]) => mockAppendApprovedToolResult(...a),
    markApprovedExecutionStatus: (...a: unknown[]) => mockMarkApprovedExecutionStatus(...a),
  }),
);

const mockDispatchTool = vi.fn();
vi.mock("@vex-agent/tools/dispatcher.js", () => ({
  dispatchTool: (...a: unknown[]) => mockDispatchTool(...a),
}));

vi.mock("@vex-agent/db/repos/approval-intents.js", () => ({
  markExecutionStatus: vi.fn(),
}));

vi.mock("@vex-agent/engine/core/hydrate.js", () => ({
  hydrateEngineSession: vi.fn().mockResolvedValue(null),
  buildSessionWalletResolution: vi.fn(),
}));

vi.mock("@vex-agent/engine/wake/blob-refresh.js", () => ({
  refreshBlobTtlForRecentMessages: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@vex-agent/engine/core/approval-runtime/continuation.js", () => ({
  claimResumeContinuation: vi.fn(),
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
});

describe("applyApproveSideEffects — explorer ref derivation", () => {
  it("derives refs from the coherent capture and passes them to the append", async () => {
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
    // 4th arg is the derived refs — coherent chain+txRef from the capture.
    const call = mockAppendApprovedToolResult.mock.calls[0]!;
    expect(call[0]).toBe("s1");
    expect(call[1]).toBe("tc-1");
    expect(call[3]).toEqual([{ chain: "hyperliquid", txRef: "0xdead" }]);
  });

  it("passes empty refs when the dispatch result carries no capture", async () => {
    mockDispatchTool.mockResolvedValue({ success: true, output: "{}", data: {} });

    await applyApproveSideEffects("appr-1", approvedSnapshot());

    expect(mockAppendApprovedToolResult.mock.calls[0]![3]).toEqual([]);
  });
});
