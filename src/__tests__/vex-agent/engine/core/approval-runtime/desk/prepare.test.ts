import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PreparedActionFollowUp } from "@vex-agent/tools/types.js";

const mocks = vi.hoisted(() => ({
  dispatch: vi.fn(), enqueue: vi.fn(), dispose: vi.fn(), context: vi.fn(),
}));
vi.mock("@vex-agent/tools/dispatcher.js", () => ({ dispatchTool: mocks.dispatch }));
vi.mock("@vex-agent/engine/core/approval-runtime/enqueue.js", () => ({ enqueueApprovalIntentWithGate: mocks.enqueue }));
vi.mock("@vex-agent/engine/core/approval-runtime/post-tx/dispatch-approved/resumed-tool-context.js", () => ({ buildResumedApprovalToolContext: mocks.context }));
vi.mock("@utils/logger.js", () => ({ default: { info: vi.fn(), warn: vi.fn() } }));

import { DESK_PREPARE_TOOL_IDS, prepareDeskApproval } from "@vex-agent/engine/core/approval-runtime/desk/prepare.js";

const intentId = "lighter-lifecycle-11111111-1111-4111-8111-111111111111";
function followUp(): PreparedActionFollowUp {
  return {
    toolName: "execute_tool", args: { toolId: "lighter.order.cancelAll", params: { intentId } },
    expiresAt: "2026-10-05T20:00:00.000Z",
    approvalPreview: {
      toolName: "order.cancelAll", namespace: "lighter", criticalArgs: {
        toolId: "lighter.order.cancelAll", intentId, actionType: "cancel_all", environment: "rhc",
        accountIndex: 42, apiKeyIndex: 4, orderCount: 2, orderIdentities: "7:9001,8:9002",
        timeInForce: 0, cancelAtMs: "0", matchHash: "a".repeat(64), summary: "Cancel two active orders across this account.",
      },
    },
  };
}
const input = { sessionId: "session-1", toolId: "lighter.order.cancelAll.prepare", params: { environment: "rhc", accountIndex: 42 } } as const;

describe("desk cancel-all preparation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.dispatch.mockReset();
    mocks.context.mockResolvedValue({
      sessionId: input.sessionId, loadedDocuments: new Map(), sessionPermission: "full",
      approved: true, approvalId: "unrelated", disposeDispatch: mocks.dispose,
    });
    mocks.enqueue.mockResolvedValue({ kind: "enqueued", approvalId: "approval-all" });
  });

  it("admits only preparation and uses canonical validated facts in a restricted desk approval", async () => {
    expect(DESK_PREPARE_TOOL_IDS).toContain("lighter.order.cancelAll.prepare");
    expect(DESK_PREPARE_TOOL_IDS).not.toContain("lighter.order.cancelAll");
    const prepared = followUp();
    mocks.dispatch.mockResolvedValueOnce({ success: true, output: "prepared", preparedActionFollowUp: prepared })
      .mockResolvedValueOnce({ success: false, output: "Confirm exact cancellation.", pendingApproval: true, actionKind: "user_wallet_broadcast" });
    await expect(prepareDeskApproval(input)).resolves.toEqual({ kind: "enqueued", approvalId: "approval-all" });
    expect(mocks.dispatch).toHaveBeenNthCalledWith(1, expect.objectContaining({
      name: "execute_tool", args: { toolId: input.toolId, params: input.params },
    }), expect.objectContaining({ sessionPermission: "restricted", approved: false, approvalId: null, deskPreparation: true }));
    expect(mocks.dispatch).toHaveBeenNthCalledWith(2, expect.objectContaining({
      name: "execute_tool", args: { toolId: "lighter.order.cancelAll", params: { intentId } },
    }), expect.objectContaining({ sessionPermission: "restricted", approved: false, approvalId: null }));
    expect(mocks.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      permission: "restricted", origin: "desk", toolArgs: prepared.args,
      trustedPreview: prepared.approvalPreview, trustedExpiresAt: prepared.expiresAt,
    }), expect.any(Function));
    expect(mocks.dispose).toHaveBeenCalledTimes(1);
  });

  it("preserves a provider preparation refusal without a follow-up or enqueue", async () => {
    mocks.dispatch.mockResolvedValueOnce({ success: false, output: "Provider order set changed." });
    await expect(prepareDeskApproval(input)).resolves.toEqual({ kind: "refused", reason: "Provider order set changed." });
    expect(mocks.dispatch).toHaveBeenCalledTimes(1);
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(mocks.dispose).toHaveBeenCalledTimes(1);
  });

  it.each([
    { orderCount: 3 }, { accountIndex: -1 }, { orderIdentities: "7:0,8:9002" },
  ])("refuses invalid canonical approval facts %j before the execute handoff", async (invalid) => {
    const prepared = followUp();
    mocks.dispatch.mockResolvedValueOnce({ success: true, output: "prepared", preparedActionFollowUp: {
      ...prepared, approvalPreview: { ...prepared.approvalPreview, criticalArgs: { ...prepared.approvalPreview.criticalArgs, ...invalid } },
    } });
    await expect(prepareDeskApproval(input)).resolves.toMatchObject({ kind: "refused" });
    expect(mocks.dispatch).toHaveBeenCalledTimes(1);
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it("refuses a follow-up that did not stop at the approval gate", async () => {
    mocks.dispatch.mockResolvedValueOnce({ success: true, output: "prepared", preparedActionFollowUp: followUp() })
      .mockResolvedValueOnce({ success: true, output: "unexpected success" });
    await expect(prepareDeskApproval(input)).resolves.toMatchObject({ kind: "refused" });
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(mocks.dispose).toHaveBeenCalledTimes(1);
  });
});
