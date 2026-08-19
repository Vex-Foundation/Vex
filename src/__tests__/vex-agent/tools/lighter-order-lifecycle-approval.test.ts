import { beforeEach, describe, expect, it, vi } from "vitest";

const getApproval = vi.fn();
const getAudit = vi.fn();

vi.mock("@vex-agent/db/repos/approvals.js", () => ({
  getByIdForSession: (...args: unknown[]) => getApproval(...args),
}));
vi.mock("@vex-agent/db/repos/approval-intents.js", () => ({
  getByApprovalId: (...args: unknown[]) => getAudit(...args),
}));

const { assertLighterCancelOneApprovalBinding } = await import(
  "@vex-agent/tools/protocols/lighter/order-lifecycle-approval-binding.js"
);
const { LIGHTER_ORDER_LIFECYCLE_HANDLERS } = await import(
  "@vex-agent/tools/protocols/lighter/handlers/order-lifecycle.js"
);

const intentId = "lighter-lifecycle-00000000-0000-4000-8000-000000000001";
const snapshot = {
  clientOrderId: "123",
  side: "buy",
  type: "limit",
  timeInForce: "good-till-time",
  price: "50",
  initialBaseAmount: "1",
  remainingBaseAmount: "0.5",
  filledBaseAmount: "0.5",
};
const intent = {
  intentId,
  environment: "rhc",
  accountIndex: 42,
  apiKeyIndex: 7,
  marketIndex: 0,
  providerOrderId: "1152921504606846975",
  matchHash: "b".repeat(64),
  providerSnapshotJson: snapshot,
};
const criticalArgs = {
  toolId: "lighter.order.cancel",
  intentId,
  actionType: "cancel_one",
  environment: "rhc",
  accountIndex: 42,
  apiKeyIndex: 7,
  marketIndex: 0,
  providerOrderId: "1152921504606846975",
  clientOrderId: "123",
  side: "buy",
  orderType: "limit",
  timeInForce: "good-till-time",
  price: "50",
  initialBaseAmount: "1",
  remainingBaseAmount: "0.5",
  filledBaseAmount: "0.5",
  matchHash: "b".repeat(64),
  summary: "Cancel exact order.",
};

beforeEach(() => {
  getApproval.mockReset().mockResolvedValue({
    status: "approved",
    toolCall: {
      command: "execute_tool",
      args: { toolId: "lighter.order.cancel", params: { intentId } },
    },
  });
  getAudit.mockReset().mockResolvedValue({
    sessionId: "session-1",
    decision: "approved",
    actionKind: "external_post",
    executionStatus: "dispatching",
    previewJson: { toolName: "order.cancel", namespace: "lighter", criticalArgs },
  });
});

describe("Lighter cancel-one approval binding", () => {
  it("accepts only the exact provider order and immutable provider snapshot", async () => {
    await expect(assertLighterCancelOneApprovalBinding({
      approvalId: "approval-1",
      sessionId: "session-1",
      intent: intent as never,
    })).resolves.toBeUndefined();
  });

  it("rejects any altered provider identity before execution", async () => {
    getAudit.mockResolvedValueOnce({
      sessionId: "session-1",
      decision: "approved",
      actionKind: "external_post",
      executionStatus: "dispatching",
      previewJson: {
        toolName: "order.cancel",
        namespace: "lighter",
        criticalArgs: { ...criticalArgs, providerOrderId: "1152921504606846974" },
      },
    });
    await expect(assertLighterCancelOneApprovalBinding({
      approvalId: "approval-1",
      sessionId: "session-1",
      intent: intent as never,
    })).rejects.toThrow("approval does not match the exact provider order intent");
  });

  it("keeps direct calls behind the host approval gate", async () => {
    const result = await LIGHTER_ORDER_LIFECYCLE_HANDLERS["lighter.order.cancel"]!(
      { intentId },
      { sessionId: "session-1" } as never,
    );
    expect(result).toMatchObject({ success: false, pendingApproval: true });
    expect(getApproval).not.toHaveBeenCalled();
  });
});
