/**
 * A0.3 — the resume-side half of the durable direct-call envelope, wired into
 * `applyApproveSideEffects`.
 *
 * The envelope carries a fingerprint of the manifest the human approved. If the
 * contract behind that toolId changed while the approval waited, the resume
 * must NOT dispatch: executing against a different contract than the one the
 * human saw is the silent substitution the fingerprint exists to prevent.
 *
 * It is a CONTROLLED refusal, not a throw — the refusal is committed as the
 * tool result and the agent resumes knowing nothing ran. A throw would park the
 * run in `paused_error` and offer `/retry` on a money-path action that must not
 * be retried without a fresh approval.
 *
 * Harness mirrors `dispatch-approved-refs.test.ts`; the catalog is REAL here so
 * the fingerprint under test is a real manifest's.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockCommitApprovedToolResult = vi.fn();
vi.mock(
  "@vex-agent/engine/core/approval-runtime/post-tx/result-message.js",
  () => ({
    commitApprovedToolResult: (...a: unknown[]) => mockCommitApprovedToolResult(...a),
    commitDispatchFailureToolResult: vi.fn(),
    commitDecisionToolResult: vi.fn(),
  }),
);

const mockDispatchTool = vi.fn();
vi.mock("@vex-agent/tools/dispatcher.js", () => ({
  dispatchTool: (...a: unknown[]) => mockDispatchTool(...a),
}));

vi.mock("@vex-agent/db/repos/approval-intents.js", () => ({
  markExecutionStatus: vi.fn(),
  casMarkDispatchingWith: vi.fn().mockResolvedValue(true),
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

vi.mock("@vex-agent/engine/core/approval-runtime/deferred-resume.js", () => ({
  scheduleDeferredResumeRetries: vi.fn(),
}));

vi.mock("@vex-agent/db/client.js", () => ({
  withTransaction: async <T>(fn: (client: unknown) => Promise<T>): Promise<T> =>
    fn({ query: vi.fn() }),
}));

vi.mock("@vex-agent/engine/runtime/lease-and-status.js", () => ({
  gateOnOperatorStopWithClient: async () => ({ kind: "clear" }),
  acquireSessionControlLock: vi.fn(),
  gateOnOperatorStopTransaction: vi.fn().mockResolvedValue({ kind: "clear" }),
}));

vi.mock("@utils/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { applyApproveSideEffects } = await import(
  "@vex-agent/engine/core/approval-runtime/post-tx/dispatch-approved.js"
);
const { computeManifestFingerprint } = await import(
  "@vex-agent/engine/core/approval-runtime/tool-call-envelope.js"
);
const { getProtocolManifest } = await import("@vex-agent/tools/protocols/catalog.js");

const TOOL_ID = "dexscreener.search";
const LIVE_MANIFEST = getProtocolManifest(TOOL_ID);
if (!LIVE_MANIFEST) throw new Error(`${TOOL_ID} must exist for this test`);

function snapshotWith(queueToolCall: Record<string, unknown>) {
  return {
    type: "approved_in_tx" as const,
    queueResolvedAt: "2026-08-03T00:00:00.000Z",
    row: {
      approval_id: "appr-1",
      session_id: "s1",
      mission_run_id: null,
      tool_call_id: null,
      queue_tool_call_id: "tc-1",
      queue_tool_call: queueToolCall,
      queue_permission_at_enqueue: "restricted",
    },
  } as unknown as Parameters<typeof applyApproveSideEffects>[1];
}

function envelope(fingerprint: string) {
  return {
    command: "execute_tool",
    args: { toolId: TOOL_ID, params: { query: "VEX" } },
    vex: { v: 1, originalToolName: "dexscreener__search", manifestFingerprint: fingerprint },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
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
  mockDispatchTool.mockResolvedValue({ success: true, output: "ok", data: {} });
});

describe("applyApproveSideEffects — manifest identity", () => {
  it("dispatches the canonicalized envelope when the fingerprint still matches", async () => {
    const snapshot = snapshotWith(envelope(computeManifestFingerprint(LIVE_MANIFEST)));

    const outcome = await applyApproveSideEffects("appr-1", snapshot);

    expect(mockDispatchTool).toHaveBeenCalledTimes(1);
    expect(mockDispatchTool.mock.calls[0]![0]).toEqual({
      name: "execute_tool",
      args: { toolId: TOOL_ID, params: { query: "VEX" } },
      toolCallId: "tc-1",
    });
    expect(outcome.kind).toBe("dispatched");
  });

  it("REFUSES without dispatching when the manifest changed under a queued approval", async () => {
    const snapshot = snapshotWith(envelope("f".repeat(32)));

    const outcome = await applyApproveSideEffects("appr-1", snapshot);

    expect(mockDispatchTool).not.toHaveBeenCalled();
    if (outcome.kind !== "dispatched") throw new Error("expected a committed outcome");
    expect(outcome.executionStatus).toBe("failed");
    expect(outcome.toolResult?.output).toContain("Nothing was executed");
    // The refusal is durable history, exactly like any other tool result.
    const committed = mockCommitApprovedToolResult.mock.calls[0]![0] as {
      dispatchResult: { success: boolean; output: string };
    };
    expect(committed.dispatchResult.success).toBe(false);
    expect(committed.dispatchResult.output).toContain("fresh approval");
  });

  it("replays a HISTORICAL row (no metadata block) unchanged", async () => {
    const snapshot = snapshotWith({ command: "wallet_send_confirm", args: { id: "x" } });

    await applyApproveSideEffects("appr-1", snapshot);

    expect(mockDispatchTool).toHaveBeenCalledTimes(1);
    expect(mockDispatchTool.mock.calls[0]![0]).toEqual({
      name: "wallet_send_confirm",
      args: { id: "x" },
      toolCallId: "tc-1",
    });
  });

  it("resumes with `approved: true` and NO model provenance, so execute_tool stays open to it", async () => {
    const snapshot = snapshotWith(envelope(computeManifestFingerprint(LIVE_MANIFEST)));

    await applyApproveSideEffects("appr-1", snapshot);

    const context = mockDispatchTool.mock.calls[0]![1] as {
      approved: boolean;
      approvalId: string | null;
      modelOriginated?: true;
    };
    expect(context.approved).toBe(true);
    expect(context.approvalId).toBe("appr-1");
    expect(context.modelOriginated).toBeUndefined();
  });
});
