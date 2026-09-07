import { requireValue } from "../../helpers/require-value.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getApproval = vi.fn();
const getAudit = vi.fn();

vi.mock("@vex-agent/db/repos/approvals.js", () => ({
  getByIdForSession: (...args: unknown[]) => getApproval(...args),
}));
vi.mock("@vex-agent/db/repos/approval-intents.js", () => ({
  getByApprovalId: (...args: unknown[]) => getAudit(...args),
}));

const { assertLighterCancelAllApprovalBinding, assertLighterCancelOneApprovalBinding, assertLighterClosePositionApprovalBinding, assertLighterModifyOrderApprovalBinding } = await import(
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

describe("Lighter modify-order approval binding", () => {
  const modifyIntent = {
    ...intent,
    actionType: "modify",
    requestedBaseAmountInteger: "7500",
    requestedPriceInteger: "5125",
    providerSnapshotJson: {
      ...snapshot,
      requestedBaseAmount: "0.75",
      requestedPrice: "51.25",
    },
  };
  const modifyCriticalArgs = {
    ...criticalArgs,
    toolId: "lighter.order.modify",
    actionType: "modify",
    requestedBaseAmount: "0.75",
    requestedBaseAmountInteger: "7500",
    requestedPrice: "51.25",
    requestedPriceInteger: "5125",
    summary: "Modify exact order.",
  };

  function useModifyApproval(): void {
    getApproval.mockResolvedValueOnce({
      status: "approved",
      toolCall: {
        command: "execute_tool",
        args: { toolId: "lighter.order.modify", params: { intentId } },
      },
    });
    getAudit.mockResolvedValueOnce({
      sessionId: "session-1",
      decision: "approved",
      actionKind: "external_post",
      executionStatus: "dispatching",
      previewJson: { toolName: "order.modify", namespace: "lighter", criticalArgs: modifyCriticalArgs },
    });
  }

  it("accepts only the exact original order and replacement values", async () => {
    useModifyApproval();
    await expect(assertLighterModifyOrderApprovalBinding({
      approvalId: "approval-1",
      sessionId: "session-1",
      intent: modifyIntent,
    })).resolves.toBeUndefined();
  });

  it("rejects an altered replacement price", async () => {
    getApproval.mockResolvedValueOnce({
      status: "approved",
      toolCall: { command: "execute_tool", args: { toolId: "lighter.order.modify", params: { intentId } } },
    });
    getAudit.mockResolvedValueOnce({
      sessionId: "session-1",
      decision: "approved",
      actionKind: "external_post",
      executionStatus: "dispatching",
      previewJson: {
        toolName: "order.modify",
        namespace: "lighter",
        criticalArgs: { ...modifyCriticalArgs, requestedPriceInteger: "5126" },
      },
    });
    await expect(assertLighterModifyOrderApprovalBinding({
      approvalId: "approval-1",
      sessionId: "session-1",
      intent: modifyIntent,
    })).rejects.toThrow("approval does not match the exact provider order and replacement values");
  });

  it("keeps direct modify calls behind the host approval gate", async () => {
    const result = await requireValue(LIGHTER_ORDER_LIFECYCLE_HANDLERS["lighter.order.modify"])(
      { intentId },
      { sessionId: "session-1" },
    );
    expect(result).toMatchObject({ success: false, pendingApproval: true });
  });
});

describe("Lighter cancel-all approval binding", () => {
  const orders = [
    { marketIndex: 0, orderId: "1152921504606846975" },
    { marketIndex: 1, orderId: "281474976710657" },
  ];
  const cancelAllIntent = {
    ...intent,
    actionType: "cancel_all",
    marketIndex: null,
    providerOrderId: null,
    matchHash: "c".repeat(64),
    providerSnapshotJson: { orders, orderCount: 2, timeInForce: 0, cancelAtMs: "0" },
  };
  const cancelAllCritical = {
    toolId: "lighter.order.cancelAll",
    intentId,
    actionType: "cancel_all",
    environment: "rhc",
    accountIndex: 42,
    apiKeyIndex: 7,
    orderCount: 2,
    orderIdentities: "0:1152921504606846975,1:281474976710657",
    timeInForce: 0,
    cancelAtMs: "0",
    matchHash: "c".repeat(64),
    summary: "Immediately cancel exactly two active orders.",
  };

  function useCancelAllApproval(critical = cancelAllCritical): void {
    getApproval.mockResolvedValueOnce({
      status: "approved",
      toolCall: {
        command: "execute_tool",
        args: { toolId: "lighter.order.cancelAll", params: { intentId } },
      },
    });
    getAudit.mockResolvedValueOnce({
      sessionId: "session-1",
      decision: "approved",
      actionKind: "external_post",
      executionStatus: "dispatching",
      previewJson: { toolName: "order.cancelAll", namespace: "lighter", criticalArgs: critical },
    });
  }

  it("accepts only the exact account-wide active-order set", async () => {
    useCancelAllApproval();
    await expect(assertLighterCancelAllApprovalBinding({
      approvalId: "approval-1",
      sessionId: "session-1",
      intent: cancelAllIntent,
    })).resolves.toBeUndefined();
  });

  it("rejects an altered account-wide order identity", async () => {
    useCancelAllApproval({ ...cancelAllCritical, orderIdentities: "0:1152921504606846974,1:281474976710657" });
    await expect(assertLighterCancelAllApprovalBinding({
      approvalId: "approval-1",
      sessionId: "session-1",
      intent: cancelAllIntent,
    })).rejects.toThrow("approval does not match the exact account-wide active-order set");
  });

  it("keeps direct cancel-all calls behind the host approval gate", async () => {
    const result = await requireValue(LIGHTER_ORDER_LIFECYCLE_HANDLERS["lighter.order.cancelAll"])(
      { intentId },
      { sessionId: "session-1" },
    );
    expect(result).toMatchObject({ success: false, pendingApproval: true });
  });
});

describe("Lighter close-position approval binding", () => {
  const closeIntent = {
    ...intent,
    actionType: "close_position",
    providerOrderId: null,
    requestedBaseAmountInteger: "10000",
    requestedPriceInteger: "4950",
    requestedSide: "sell",
    reduceOnly: true,
    matchHash: "d".repeat(64),
    providerSnapshotJson: {
      position: {
        marketIndex: 0,
        symbol: "ETH",
        sign: 1,
        side: "long",
        position: "1",
        averageEntryPrice: "45",
      },
      baseAmount: "1",
      worstAcceptablePrice: "49.5",
      maxSlippageBps: 100,
    },
  };
  const closeCritical = {
    toolId: "lighter.position.close",
    intentId,
    actionType: "close_position",
    environment: "rhc",
    accountIndex: 42,
    apiKeyIndex: 7,
    marketIndex: 0,
    symbol: "ETH",
    positionSide: "long",
    positionAmount: "1",
    averageEntryPrice: "45",
    closingSide: "sell",
    baseAmount: "1",
    baseAmountInteger: "10000",
    worstAcceptablePrice: "49.5",
    priceInteger: "4950",
    maxSlippageBps: 100,
    reduceOnly: true,
    orderType: "market",
    timeInForce: "immediate-or-cancel",
    matchHash: "d".repeat(64),
    summary: "Close the entire ETH long.",
  };

  function useCloseApproval(critical = closeCritical): void {
    getApproval.mockResolvedValueOnce({
      status: "approved",
      toolCall: {
        command: "execute_tool",
        args: { toolId: "lighter.position.close", params: { intentId } },
      },
    });
    getAudit.mockResolvedValueOnce({
      sessionId: "session-1",
      decision: "approved",
      actionKind: "external_post",
      executionStatus: "dispatching",
      previewJson: { toolName: "position.close", namespace: "lighter", criticalArgs: critical },
    });
  }

  it("accepts only the exact reduce-only close size, side, and slippage price", async () => {
    useCloseApproval();
    await expect(assertLighterClosePositionApprovalBinding({
      approvalId: "approval-1",
      sessionId: "session-1",
      intent: closeIntent,
    })).resolves.toBeUndefined();
  });

  it("rejects an altered close price", async () => {
    useCloseApproval({ ...closeCritical, priceInteger: "4951" });
    await expect(assertLighterClosePositionApprovalBinding({
      approvalId: "approval-1",
      sessionId: "session-1",
      intent: closeIntent,
    })).rejects.toThrow("approval does not match the exact live position");
  });

  it("keeps direct close calls behind the host approval gate", async () => {
    const result = await requireValue(LIGHTER_ORDER_LIFECYCLE_HANDLERS["lighter.position.close"])(
      { intentId },
      { sessionId: "session-1" },
    );
    expect(result).toMatchObject({ success: false, pendingApproval: true });
  });
});

describe("Lighter cancel-one approval binding", () => {
  it("accepts only the exact provider order and immutable provider snapshot", async () => {
    await expect(assertLighterCancelOneApprovalBinding({
      approvalId: "approval-1",
      sessionId: "session-1",
      intent: intent,
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
      intent: intent,
    })).rejects.toThrow("approval does not match the exact provider order intent");
  });

  it("keeps direct calls behind the host approval gate", async () => {
    const result = await requireValue(LIGHTER_ORDER_LIFECYCLE_HANDLERS["lighter.order.cancel"])(
      { intentId },
      { sessionId: "session-1" },
    );
    expect(result).toMatchObject({ success: false, pendingApproval: true });
    expect(getApproval).not.toHaveBeenCalled();
  });
});
