/**
 * A rejected card RETIRES the Vex Inference deposit intent it was bound to,
 * on every rejection path: the user's reject and the expiry sweep
 * (`dispatchRejectSideEffects`), the policy-drift block
 * (`dispatchPolicyDriftSideEffects`), and the run-terminal auto-reject inside
 * the turn loop's enqueue (`enqueueApprovalIntent`).
 *
 * REAL: the two origin-aware dispatchers, the turn loop's enqueue wrapper,
 * the binding reader and the retirement hook. FAKED: the transcript side
 * effects, the enqueue transaction, and the host.
 *
 * Does not prove that a retired intent cannot be signed (the dispatcher
 * suite and `vex-app` `auto-top-up-authority.test.ts` do).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@vex-agent/engine/core/approval-runtime/post-tx/reject.js", () => ({
  applyRejectSideEffects: vi.fn(async () => ({ kind: "rejected" })),
  applyPolicyDriftSideEffects: vi.fn(async () => ({ kind: "policy_drift_blocked" })),
}));
vi.mock("@vex-agent/engine/runtime/studio-settlement-bus.js", () => ({ emitStudioSettlement: vi.fn() }));
vi.mock("@vex-agent/engine/core/approval-runtime/enqueue.js", () => ({
  enqueueApprovalIntentWithGate: vi.fn(async () => ({ kind: "auto_rejected", approvalId: "approval-3", runStatus: "stopped" })),
}));
vi.mock("@vex-agent/engine/runtime/lease-and-status.js", () => ({
  acquireSessionControlLock: vi.fn(),
  gateOnOperatorStopWithClient: vi.fn(),
}));

const { dispatchPolicyDriftSideEffects, dispatchRejectSideEffects } = await import(
  "@vex-agent/engine/core/approval-runtime/post-tx/reject-dispatch.js"
);
const { enqueueApprovalIntent } = await import("@vex-agent/engine/core/turn-loop-tool-batch/approval-stop.js");
const { registerVexInferenceHost, resetVexInferenceHost } = await import("@vex-agent/tools/internal/vex-inference/host.js");
const { depositApprovalBinding } = await import("@vex-agent/tools/internal/vex-inference/approval-binding.js");
const { buildApprovalToolCall } = await import("@vex-agent/engine/core/approval-runtime/tool-call-envelope.js");
const { makeTestContext } = await import("../../tools/_test-context.js");
const { makeEngineContext } = await import("../_engine-context.js");
import type { AgentDepositIntentView, VexInferenceHost } from "@vex-agent/tools/internal/vex-inference/host.js";
import type { IntentSnapshotRow } from "@vex-agent/engine/core/approval-runtime/snapshot/types.js";

const INTENT = "vxdep-00000000-0000-4000-8000-000000000001";

function view(): AgentDepositIntentView {
  const amount = { wei: "6000000000000000000000", vex: "6000", usdMicroEstimate: null, usdEstimate: null };
  return {
    intentId: INTENT,
    chainId: 4663,
    token: { address: "0x8Ff92566f2e81BDd68EDfAa8cde73942A723796b", symbol: "VEX", decimals: 18 },
    amount,
    requested: { unit: "VEX", value: "6000" },
    from: "0x1111111111111111111111111111111111111111",
    depositAddress: "0x00000000000000000000000000000000000D3905",
    minimum: amount,
    networkFee: { gasLimit: "1", maxFeePerGasWei: "1", maxPriorityFeePerGasWei: "0", maxNetworkFeeWei: "1", nativeSymbol: "ETH", nativeDecimals: 18 },
    walletVex: amount,
    preparedAt: "2026-10-21T12:00:00.000Z",
    expiresAt: "2026-10-21T12:10:00.000Z",
    autoTopUp: { covered: false, reason: "none" },
  };
}

const retired: Array<[string, string]> = [];
const host: VexInferenceHost = {
  readStatus: vi.fn(),
  prepareAgentDeposit: vi.fn(),
  peekAgentDeposit: vi.fn(),
  confirmAgentDeposit: vi.fn(),
  retireAgentDeposit: (sessionId, intentId) => {
    retired.push([sessionId, intentId]);
  },
};

function row(toolCall: Record<string, unknown>): IntentSnapshotRow {
  return {
    approval_id: "approval-1",
    session_id: "session-a",
    mission_run_id: null,
    tool_call_id: "tc-1",
    expires_at: null,
    decision: "rejected",
    decision_reason: null,
    decided_at: null,
    execution_status: null,
    execution_result_hash: null,
    origin: "agent",
    project_id: null,
    scope_version_at_enqueue: null,
    request_digest: null,
    queue_status: "rejected",
    queue_resolved_at: null,
    queue_created_at: "2026-10-21T12:00:00.000Z",
    queue_tool_call: toolCall,
    queue_tool_call_id: "tc-1",
    queue_permission_at_enqueue: "restricted",
    session_permission_live: "restricted",
  };
}

beforeEach(() => {
  retired.length = 0;
  registerVexInferenceHost(host);
  return () => resetVexInferenceHost();
});

const boundEnvelope = () => buildApprovalToolCall("VexInferenceDepositConfirm", { intentId: INTENT }, depositApprovalBinding(view()));

describe("a rejected deposit card retires its intent", () => {
  it("on the user's reject and the expiry sweep", async () => {
    await dispatchRejectSideEffects("approval-1", { type: "rejected_in_tx", row: row(boundEnvelope()), queueResolvedAt: "2026-10-21T12:01:00.000Z", reason: "no" }, "rejected");
    expect(retired).toEqual([["session-a", INTENT]]);
  });

  it("on a policy-drift block", async () => {
    await dispatchPolicyDriftSideEffects(
      "approval-1",
      { type: "policy_drift_blocked", row: row(boundEnvelope()), queueResolvedAt: "2026-10-21T12:01:00.000Z", reason: "permission changed", permissionAtEnqueue: "restricted", livePermission: "restricted", driftKind: "session_permission", refusalReason: null },
      "blocked",
    );
    expect(retired).toEqual([["session-a", INTENT]]);
  });

  it("on the run-terminal auto-reject inside the enqueue", async () => {
    await enqueueApprovalIntent({
      context: makeEngineContext({ sessionId: "session-a", missionRunId: null, sessionPermission: "restricted" }),
      toolCall: { id: "tc-1", name: "VexInferenceDepositConfirm", arguments: { intentId: INTENT } },
      result: { success: false, output: "needs approval", pendingApproval: true, actionKind: "user_wallet_broadcast", preparedApprovalBinding: depositApprovalBinding(view()) },
      toolContext: makeTestContext({ sessionId: "session-a" }),
      intentActionKind: "user_wallet_broadcast",
    });
    expect(retired).toEqual([["session-a", INTENT]]);
  });

  it("leaves every other approval alone", async () => {
    await dispatchRejectSideEffects("approval-1", { type: "rejected_in_tx", row: row(buildApprovalToolCall("WalletSendConfirm", { intentId: "intent-1" })), queueResolvedAt: "2026-10-21T12:01:00.000Z", reason: "no" }, "rejected");
    expect(retired).toEqual([]);
  });
});
