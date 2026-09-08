import { requireValue } from "../../../helpers/require-value.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InternalToolContext } from "@vex-agent/tools/internal/types.js";
import type { ApproveSnapshot } from "@vex-agent/engine/core/approval-runtime/snapshot.js";
import { toProtocolExecutionContext } from "@vex-agent/tools/protocols/execution-context.js";

const mocks = vi.hoisted(() => ({
  execute: vi.fn(), claim: vi.fn(), slot: vi.fn(), studioGate: vi.fn(), commit: vi.fn(), hydrate: vi.fn(),
  intent: { intentId: "lighter-lifecycle-00000000-0000-4000-8000-000000000001", expiresAt: "2099-01-01T00:00:00.000Z" },
}));
vi.mock("@utils/logger.js", () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock("@vex-agent/db/client.js", () => ({
  withTransaction: async (fn: (client: object) => Promise<unknown>) => fn({}),
  queryOne: vi.fn(), query: vi.fn(), queryOneWith: vi.fn(),
}));
vi.mock("@vex-agent/db/repos/approval-intents.js", () => ({
  commitStudioSettlementWith: mocks.commit,
  casMarkIndeterminateWithSettlementWith: vi.fn(async () => true),
}));
vi.mock("@vex-agent/db/repos/lighter-order-lifecycle-intents.js", () => ({
  findByIntentId: async () => mocks.intent,
  markApprovalDecision: async () => mocks.intent,
}));
vi.mock("@vex-agent/tools/protocols/lighter/order-lifecycle-approval-binding.js", () => ({
  assertLighterCancelOneApprovalBinding: vi.fn(),
}));
vi.mock("@vex-agent/tools/protocols/lighter/order-lifecycle.js", () => ({
  getConfiguredLighterOrderLifecycleExecutionDeps: () => ({}),
  executeApprovedLighterCancelOne: mocks.execute,
}));
vi.mock("@vex-agent/engine/core/hydrate.js", () => ({
  hydrateEngineSession: mocks.hydrate, buildSessionWalletResolution: vi.fn(),
}));
vi.mock("@vex-agent/engine/core/approval-runtime/continuation.js", () => ({
  claimResumeContinuation: mocks.claim, discardContinuation: vi.fn(),
}));
vi.mock("@vex-agent/engine/core/approval-runtime/deferred-resume.js", () => ({ scheduleDeferredResumeRetries: vi.fn() }));
vi.mock("@vex-agent/engine/core/approval-runtime/post-tx/result-message.js", () => ({
  commitApprovedToolResult: mocks.commit, commitDispatchFailureToolResult: mocks.commit,
}));
vi.mock("@vex-agent/engine/core/approval-runtime/post-tx/dispatch-approved/dispatch-slot-gate.js", () => ({
  claimDispatchSlotUnderStopGate: mocks.slot,
}));
vi.mock("@vex-agent/engine/runtime/lease-and-status.js", () => ({
  gateOnOperatorStopTransaction: async () => ({ kind: "clear" }),
}));
vi.mock("@vex-agent/engine/core/approval-runtime/post-tx/dispatch-approved/studio-gate.js", () => ({
  runStudioDispatchGate: mocks.studioGate,
  refuseStudioBeforeDispatch: vi.fn(), STUDIO_REFUSAL_CAUSES: {},
}));
vi.mock("@vex-agent/engine/core/approval-runtime/post-tx/dispatch-approved/studio-project-scope.js", () => ({
  loadProjectScope: async () => ({ projectId: "project-1", backingSessionId: "session-1", scopeVersion: 1,
    permission: "full", wallets: { evm: null, solana: null } }),
  ProjectDeletedError: class extends Error {},
}));
vi.mock("@vex-agent/engine/core/approval-runtime/tool-call-envelope.js", () => ({
  extractToolCall: () => ({ toolName: "lighter.order.cancel", toolArgs: { intentId: "lighter-lifecycle-00000000-0000-4000-8000-000000000001" }, toolCallId: "call-1" }),
  readStudioApprovalToolCall: () => ({ toolName: "lighter.order.cancel", toolArgs: { intentId: "lighter-lifecycle-00000000-0000-4000-8000-000000000001" }, toolCallId: "call-1" }),
  checkApprovalManifestIdentity: () => ({ ok: true }), approvalRequestDigestMatches: () => true,
  studioAuthorityDigestMatches: () => true, approvalPreviewExactlyMatches: () => true,
  readApprovalQuoteAuthority: () => null, readApprovalPrequoteAuthority: () => null,
}));
vi.mock("@vex-agent/engine/core/approval-runtime/enqueue.js", () => ({ buildApprovalIntentPreview: () => ({}) }));
vi.mock("@vex-agent/tools/dispatcher.js", () => ({
  dispatchTool: async (_call: unknown, context: InternalToolContext) => {
    const { LIGHTER_ORDER_LIFECYCLE_HANDLERS } = await import("@vex-agent/tools/protocols/lighter/handlers/order-lifecycle.js");
    return requireValue(LIGHTER_ORDER_LIFECYCLE_HANDLERS["lighter.order.cancel"])({ intentId: "lighter-lifecycle-00000000-0000-4000-8000-000000000001" }, toProtocolExecutionContext({ toolCallId: "call-1" }, context, "in_app_form"));
  },
}));
vi.mock("@vex-agent/mcp/admission.js", () => ({
  admitStudioCall: async (_call: unknown, context: InternalToolContext) => {
    if (!context.approved) return { result: { success: false, output: "approval required", pendingApproval: true }, dispatched: false };
    const { LIGHTER_ORDER_LIFECYCLE_HANDLERS } = await import("@vex-agent/tools/protocols/lighter/handlers/order-lifecycle.js");
    return { result: await requireValue(LIGHTER_ORDER_LIFECYCLE_HANDLERS["lighter.order.cancel"])({ intentId: "lighter-lifecycle-00000000-0000-4000-8000-000000000001" }, toProtocolExecutionContext({ toolCallId: "call-1" }, context, "studio_mcp")), dispatched: true };
  },
}));

const { applyApproveSideEffects } = await import("@vex-agent/engine/core/approval-runtime/post-tx/dispatch-approved.js");
const revocations = await import("@vex-agent/engine/core/approval-runtime/studio/dispatch-preflight.js");

function snapshot(studio: boolean): Extract<ApproveSnapshot, { type: "approved_in_tx" }> {
  return {
    type: "approved_in_tx", queueResolvedAt: "2030-01-01T00:00:00.000Z",
    row: {
      approval_id: "approval-1", session_id: "session-1", mission_run_id: null,
      tool_call_id: "call-1", expires_at: "2099-01-01T00:00:00.000Z", preview_json: {},
      decision: "approved", decision_reason: null, decided_at: null, execution_status: "not_started",
      execution_result_hash: null, origin: studio ? "studio_mcp" : "agent",
      project_id: studio ? "project-1" : null, scope_version_at_enqueue: studio ? 1 : null,
      request_digest: null, queue_status: "approved", queue_resolved_at: null, queue_created_at: new Date(),
      queue_tool_call: { command: "lighter.order.cancel", args: { intentId: "lighter-lifecycle-00000000-0000-4000-8000-000000000001" } },
      queue_tool_call_id: "call-1", queue_permission_at_enqueue: "full", session_permission_live: "full",
    },
  };
}
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}
beforeEach(() => {
  vi.clearAllMocks();
  revocations.setStudioDispatchPreflight(null);
  mocks.claim.mockResolvedValue({ outcome: "claimed", continuation: { kind: "studio_mcp", sessionId: "session-1", projectId: "project-1" } });
  mocks.slot.mockResolvedValue({ tookSlot: true, stopGate: { kind: "clear" } });
  mocks.studioGate.mockResolvedValue({ kind: "claimed" });
  mocks.commit.mockResolvedValue(true);
  mocks.hydrate.mockResolvedValue(null);
  mocks.execute.mockResolvedValue({ status: "canceled" });
});
afterEach(() => { vi.restoreAllMocks(); revocations.setStudioDispatchPreflight(null); });

for (const studio of [true, false]) describe(studio ? "approved Studio entry" : "approved in-app entry", () => {
  it.each(["lock", "vex_quit"] as const)("forwards %s through the real handler to its executor", async (reason) => {
    const entered = gate(), finish = gate();
    let received: AbortSignal | undefined;
    mocks.execute.mockImplementation(async (_intent, _deps, signal: AbortSignal) => {
      received = signal; entered.release(); await finish.promise;
      return { status: "canceled" };
    });
    const execution = applyApproveSideEffects("approval-1", snapshot(studio));
    await entered.promise;
    expect(received?.aborted).toBe(false);
    revocations.revokeApprovedDispatches({ reason });
    expect(received?.aborted).toBe(true);
    finish.release();
    expect(await execution).toMatchObject({ kind: "dispatched", executionStatus: "succeeded" });
    expect(mocks.execute).toHaveBeenCalledOnce();
  });
  it("disposes its signal listener after a successful dispatch", async () => {
    await applyApproveSideEffects("approval-1", snapshot(studio));
    const signal = mocks.execute.mock.calls[0]?.[2] as AbortSignal;
    expect(signal).toBeInstanceOf(AbortSignal);
    revocations.revokeApprovedDispatches({ reason: "lock" });
    expect(signal.aborted).toBe(false);
  });
  it("disposes on a controlled executor failure", async () => {
    mocks.execute.mockRejectedValue(new Error("controlled fixture refusal"));
    expect(await applyApproveSideEffects("approval-1", snapshot(studio))).toMatchObject({ kind: "dispatched", executionStatus: "failed" });
    const signal = mocks.execute.mock.calls[0]?.[2] as AbortSignal;
    revocations.revokeApprovedDispatches({ reason: "lock" });
    expect(signal.aborted).toBe(false);
  });
});

it("disposes a resumed context when its dispatch slot was lost", async () => {
  const owners = vi.spyOn(revocations, "createApprovedDispatchAbortOwner");
  mocks.slot.mockResolvedValue({ tookSlot: false, stopGate: { kind: "clear" } });
  expect(await applyApproveSideEffects("approval-1", snapshot(false))).toMatchObject({ kind: "deferred_busy" });
  const owner = owners.mock.results[0]?.value as ReturnType<typeof revocations.createApprovedDispatchAbortOwner>;
  revocations.revokeApprovedDispatches({ reason: "lock" });
  expect(owner.signal.aborted).toBe(false);
  expect(mocks.execute).not.toHaveBeenCalled();
});
