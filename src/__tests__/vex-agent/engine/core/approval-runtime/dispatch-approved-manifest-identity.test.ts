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

import type { dispatchTool } from "@vex-agent/tools/dispatcher.js";
import type { commitApprovedToolResult } from "@vex-agent/engine/core/approval-runtime/post-tx/result-message.js";
import type { InternalToolContext } from "@vex-agent/tools/internal/types.js";
import type { ToolCallRequest } from "@vex-agent/tools/types.js";
import type { ApproveSnapshot } from "@vex-agent/engine/core/approval-runtime/snapshot/types.js";

const mockCommitApprovedToolResult = vi.fn<typeof commitApprovedToolResult>();
vi.mock(
  "@vex-agent/engine/core/approval-runtime/post-tx/result-message.js",
  () => ({
    commitApprovedToolResult: (input: Parameters<typeof commitApprovedToolResult>[0]) =>
      mockCommitApprovedToolResult(input),
    commitDispatchFailureToolResult: vi.fn(),
    commitDecisionToolResult: vi.fn(),
  }),
);

const mockDispatchTool = vi.fn<typeof dispatchTool>();
vi.mock("@vex-agent/tools/dispatcher.js", () => ({
  dispatchTool: (call: ToolCallRequest, context: InternalToolContext) =>
    mockDispatchTool(call, context),
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
const { computeManifestFingerprint, computeRequestDigest } = await import(
  "@vex-agent/engine/core/approval-runtime/tool-call-envelope.js"
);
const { getProtocolManifest } = await import("@vex-agent/tools/protocols/catalog.js");

const TOOL_ID = "dexscreener.search";
const LIVE_MANIFEST = getProtocolManifest(TOOL_ID);
if (!LIVE_MANIFEST) throw new Error(`${TOOL_ID} must exist for this test`);

function snapshotWith(
  queueToolCall: Record<string, unknown>,
): Extract<ApproveSnapshot, { type: "approved_in_tx" }> {
  return {
    type: "approved_in_tx",
    queueResolvedAt: "2026-08-03T00:00:00.000Z",
    row: {
      approval_id: "appr-1",
      session_id: "s1",
      mission_run_id: null,
      tool_call_id: null,
      expires_at: null,
      decision: "approved",
      decision_reason: null,
      decided_at: "2026-08-03T00:00:00.000Z",
      execution_status: null,
      execution_result_hash: null,
      queue_status: "approved",
      queue_resolved_at: "2026-08-03T00:00:00.000Z",
      queue_created_at: "2026-08-03T00:00:00.000Z",
      queue_tool_call_id: "tc-1",
      queue_tool_call: queueToolCall,
      queue_permission_at_enqueue: "restricted",
      session_permission_live: "restricted",
      origin: "agent",
      project_id: null,
      scope_version_at_enqueue: null,
      request_digest: null,
    },
  };
}

function envelope(fingerprint: string) {
  return {
    command: "execute_tool",
    args: { toolId: TOOL_ID, params: { query: "VEX" } },
    vex: { v: 2, originalToolName: "dexscreener__search", manifestFingerprint: fingerprint },
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
    expect(mockDispatchTool.mock.calls[0]?.[0]).toEqual({
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
    const committed = mockCommitApprovedToolResult.mock.calls[0]?.[0];
    expect(committed?.dispatchResult.success).toBe(false);
    expect(committed?.dispatchResult.output).toContain("fresh approval");
  });

  it("replays a HISTORICAL row (no metadata block) unchanged", async () => {
    const snapshot = snapshotWith({ command: "wallet_send_confirm", args: { id: "x" } });

    await applyApproveSideEffects("appr-1", snapshot);

    expect(mockDispatchTool).toHaveBeenCalledTimes(1);
    expect(mockDispatchTool.mock.calls[0]?.[0]).toEqual({
      name: "wallet_send_confirm",
      args: { id: "x" },
      toolCallId: "tc-1",
    });
  });

  it("REFUSES a v1-enveloped approval without dispatching — the old hash cannot be verified", async () => {
    const snapshot = snapshotWith({
      command: "execute_tool",
      args: { toolId: TOOL_ID, params: { query: "VEX" } },
      vex: {
        v: 1,
        originalToolName: "dexscreener__search",
        manifestFingerprint: computeManifestFingerprint(LIVE_MANIFEST),
      },
    });

    const outcome = await applyApproveSideEffects("appr-1", snapshot);

    expect(mockDispatchTool).not.toHaveBeenCalled();
    if (outcome.kind !== "dispatched") throw new Error("expected a committed outcome");
    expect(outcome.executionStatus).toBe("failed");
    expect(outcome.toolResult?.output).toContain("fresh approval");
  });

  it("resumes with `approved: true` and NO model provenance, so execute_tool stays open to it", async () => {
    const snapshot = snapshotWith(envelope(computeManifestFingerprint(LIVE_MANIFEST)));

    await applyApproveSideEffects("appr-1", snapshot);

    const context = mockDispatchTool.mock.calls[0]?.[1];
    expect(context?.approved).toBe(true);
    expect(context?.approvalId).toBe("appr-1");
    expect(context?.modelOriginated).toBeUndefined();
  });
});

/**
 * THE REQUEST DIGEST on the AGENT lane (pass 6 / N3) - the same check the Studio
 * lane has run since A4b, through the same owner.
 *
 * It closes the co-edit hole the card comparison cannot: `preview_json` and
 * `approval_queue.tool_call` can be edited TOGETHER and still agree with each
 * other, but neither can be edited into agreement with a digest that was taken
 * before the human approved.
 */
describe("applyApproveSideEffects - the request digest", () => {
  /** The same snapshot, with a digest recorded on the intent row. */
  function snapshotWithDigest(
    queueToolCall: Record<string, unknown>,
    digest: string | null,
  ): Extract<ApproveSnapshot, { type: "approved_in_tx" }> {
    const snapshot = snapshotWith(queueToolCall);
    return { ...snapshot, row: { ...snapshot.row, request_digest: digest } };
  }

  const PLAIN_ENVELOPE = { command: "wallet_send_confirm", args: { intentId: "wtx-1" } };

  it("dispatches when the stored envelope still hashes to the recorded digest", async () => {
    const snapshot = snapshotWithDigest(
      PLAIN_ENVELOPE,
      computeRequestDigest(PLAIN_ENVELOPE),
    );

    const outcome = await applyApproveSideEffects("appr-1", snapshot);

    expect(mockDispatchTool).toHaveBeenCalledTimes(1);
    expect(outcome.kind).toBe("dispatched");
  });

  it("REFUSES without dispatching when the stored envelope was edited after approval", async () => {
    // The digest of what the human approved, beside an envelope that now says
    // something else - the co-edit, from the dispatching side.
    const snapshot = snapshotWithDigest(
      { command: "wallet_send_confirm", args: { intentId: "wtx-ATTACKER" } },
      computeRequestDigest(PLAIN_ENVELOPE),
    );

    const outcome = await applyApproveSideEffects("appr-1", snapshot);

    expect(mockDispatchTool).not.toHaveBeenCalled();
    if (outcome.kind !== "dispatched") throw new Error("expected a committed outcome");
    expect(outcome.executionStatus).toBe("failed");
    // A CONTROLLED failure, durable like any other tool result.
    const committed = mockCommitApprovedToolResult.mock.calls[0]?.[0];
    expect(committed?.dispatchResult.success).toBe(false);
    expect(committed?.dispatchResult.output).toContain("Nothing was executed");
    expect(committed?.dispatchResult.output).toContain("fresh approval");
  });

  it("a row from before the column existed records no digest and still dispatches", async () => {
    const outcome = await applyApproveSideEffects(
      "appr-1",
      snapshotWithDigest(PLAIN_ENVELOPE, null),
    );

    expect(mockDispatchTool).toHaveBeenCalledTimes(1);
    expect(outcome.kind).toBe("dispatched");
  });
});
