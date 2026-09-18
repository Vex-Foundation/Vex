import type { LighterOrderLifecycleIntentRow } from "@vex-agent/db/repos/lighter-order-lifecycle-intents.js";
import { requireValue } from "../../helpers/require-value.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getApproval = vi.fn();
const getAudit = vi.fn();
const findByIntentId = vi.fn();
const markApprovalDecision = vi.fn();

vi.mock("@vex-agent/db/repos/approvals.js", () => ({
  getByIdForSession: (...args: unknown[]) => getApproval(...args),
}));
vi.mock("@vex-agent/db/repos/approval-intents.js", () => ({
  getByApprovalId: (...args: unknown[]) => getAudit(...args),
}));
// Only full-access reaches the repo directly in this file's tests -
// restricted-mode calls return at the host approval gate before any lookup.
// Real functions this test never exercises (createApprovalPendingWith, the
// account-wide lookups .prepare uses, etc.) pass through unmocked.
vi.mock("@vex-agent/db/repos/lighter-order-lifecycle-intents.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@vex-agent/db/repos/lighter-order-lifecycle-intents.js")>()),
  findByIntentId: (...args: unknown[]) => findByIntentId(...args),
  markApprovalDecision: (...args: unknown[]) => markApprovalDecision(...args),
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
const intent: LighterOrderLifecycleIntentRow = {
    intentId,
    sessionId: "session-1",
    protocolExecutionId: null,
    approvalId: "approval-1",
    matchHash: "b".repeat(64),
    environment: "rhc",
    accountIndex: 42,
    apiKeyIndex: 7,
    actionType: "cancel_one",
    marketIndex: 0,
    providerOrderId: "1152921504606846975",
    requestedBaseAmountInteger: null,
    requestedPriceInteger: null,
    requestedSide: null,
    reduceOnly: false,
    providerSnapshotJson: snapshot,
    credentialRefJson: {
      kind: "encrypted_vault_reference",
      environment: "rhc",
      accountIndex: 42,
      apiKeyIndex: 7,
      vaultCredentialId: "lighter/rhc/account-42/api-key-7",
    },
    approvalStatus: "approved",
    executionState: "approved",
    decisionReason: "approved",
    decidedAt: "2026-08-19T19:59:00.000Z",
    preSubmitRevalidationJson: null,
    preSubmitRevalidatedAt: null,
    nonceReservationId: null,
    nonceValue: null,
    signerExpiryMs: null,
    signerTxHash: null,
    submittedTxHash: null,
    submitCode: null,
    submitMessage: null,
    predictedExecutionTimeMs: null,
    volumeQuotaRemaining: null,
    providerOutcomeJson: null,
    providerOutcomeCheckedAt: null,
    ambiguousReason: null,
    createdAt: "2026-08-19T19:58:00.000Z",
    updatedAt: "2026-08-19T19:59:00.000Z",
    expiresAt: "2026-08-19T20:05:00.000Z",
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
  findByIntentId.mockReset().mockResolvedValue(null);
  markApprovalDecision.mockReset();
});

const FULL_CTX = {
  sessionId: "session-1",
  sessionPermission: "full" as const,
  approved: false,
  walletResolution: { source: "default" as const },
  walletPolicy: { kind: "none" as const },
};

describe("Lighter modify-order approval binding", () => {
  const modifyIntent: LighterOrderLifecycleIntentRow = {
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

  it("still refuses a full-access modify call for an intent nothing prepared", async () => {
    const result = await requireValue(LIGHTER_ORDER_LIFECYCLE_HANDLERS["lighter.order.modify"])(
      { intentId },
      FULL_CTX,
    );
    expect(result).toMatchObject({ success: false });
    expect(result.pendingApproval).not.toBe(true);
    expect(getApproval).not.toHaveBeenCalled();
    expect(markApprovalDecision).not.toHaveBeenCalled();
  });

  it("auto-approves a full-access modify call without the binding lookup", async () => {
    findByIntentId.mockResolvedValueOnce({ ...modifyIntent, expiresAt: "2030-01-01T00:00:00.000Z" });
    markApprovalDecision.mockResolvedValueOnce({ ...modifyIntent, approvalStatus: "approved" });

    const result = await requireValue(LIGHTER_ORDER_LIFECYCLE_HANDLERS["lighter.order.modify"])(
      { intentId },
      FULL_CTX,
    );

    expect(getApproval).not.toHaveBeenCalled();
    expect(getAudit).not.toHaveBeenCalled();
    expect(markApprovalDecision).toHaveBeenCalledWith(expect.objectContaining({
      decision: "approved",
      approvalId: null,
      reason: "auto-approved: session permission is full access",
    }));
    // No deps configured in this test env - proves it reached the signer
    // boundary having never required a Vex approval card.
    expect(result.pendingApproval).not.toBe(true);
    expect(result.output).toContain("dependencies are unavailable");
  });
});

describe("Lighter cancel-all approval binding", () => {
  const orders = [
    { marketIndex: 0, orderId: "1152921504606846975" },
    { marketIndex: 1, orderId: "281474976710657" },
  ];
  const cancelAllIntent: LighterOrderLifecycleIntentRow = {
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

  it("still refuses a full-access cancel-all call for an intent nothing prepared", async () => {
    const result = await requireValue(LIGHTER_ORDER_LIFECYCLE_HANDLERS["lighter.order.cancelAll"])(
      { intentId },
      FULL_CTX,
    );
    expect(result).toMatchObject({ success: false });
    expect(result.pendingApproval).not.toBe(true);
    expect(getApproval).not.toHaveBeenCalled();
    expect(markApprovalDecision).not.toHaveBeenCalled();
  });

  it("auto-approves a full-access cancel-all call without the binding lookup", async () => {
    findByIntentId.mockResolvedValueOnce({ ...cancelAllIntent, expiresAt: "2030-01-01T00:00:00.000Z" });
    markApprovalDecision.mockResolvedValueOnce({ ...cancelAllIntent, approvalStatus: "approved" });

    const result = await requireValue(LIGHTER_ORDER_LIFECYCLE_HANDLERS["lighter.order.cancelAll"])(
      { intentId },
      FULL_CTX,
    );

    expect(getApproval).not.toHaveBeenCalled();
    expect(getAudit).not.toHaveBeenCalled();
    expect(markApprovalDecision).toHaveBeenCalledWith(expect.objectContaining({
      decision: "approved",
      approvalId: null,
      reason: "auto-approved: session permission is full access",
    }));
    expect(result.pendingApproval).not.toBe(true);
    expect(result.output).toContain("dependencies are unavailable");
  });
});

describe("Lighter close-position approval binding", () => {
  const closeIntent: LighterOrderLifecycleIntentRow = {
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

  it("still refuses a full-access close call for an intent nothing prepared", async () => {
    const result = await requireValue(LIGHTER_ORDER_LIFECYCLE_HANDLERS["lighter.position.close"])(
      { intentId },
      FULL_CTX,
    );
    expect(result).toMatchObject({ success: false });
    expect(result.pendingApproval).not.toBe(true);
    expect(getApproval).not.toHaveBeenCalled();
    expect(markApprovalDecision).not.toHaveBeenCalled();
  });

  it("auto-approves a full-access close call without the binding lookup", async () => {
    findByIntentId.mockResolvedValueOnce({ ...closeIntent, expiresAt: "2030-01-01T00:00:00.000Z" });
    markApprovalDecision.mockResolvedValueOnce({ ...closeIntent, approvalStatus: "approved" });

    const result = await requireValue(LIGHTER_ORDER_LIFECYCLE_HANDLERS["lighter.position.close"])(
      { intentId },
      FULL_CTX,
    );

    expect(getApproval).not.toHaveBeenCalled();
    expect(getAudit).not.toHaveBeenCalled();
    expect(markApprovalDecision).toHaveBeenCalledWith(expect.objectContaining({
      decision: "approved",
      approvalId: null,
      reason: "auto-approved: session permission is full access",
    }));
    expect(result.pendingApproval).not.toBe(true);
    expect(result.output).toContain("dependencies are unavailable");
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

  it("still refuses a full-access cancel call for an intent nothing prepared", async () => {
    const result = await requireValue(LIGHTER_ORDER_LIFECYCLE_HANDLERS["lighter.order.cancel"])(
      { intentId },
      FULL_CTX,
    );
    expect(result).toMatchObject({ success: false });
    expect(result.pendingApproval).not.toBe(true);
    expect(getApproval).not.toHaveBeenCalled();
    expect(markApprovalDecision).not.toHaveBeenCalled();
  });

  it("auto-approves a full-access cancel call without the binding lookup", async () => {
    findByIntentId.mockResolvedValueOnce({ ...intent, expiresAt: "2030-01-01T00:00:00.000Z" });
    markApprovalDecision.mockResolvedValueOnce({ ...intent, approvalStatus: "approved" });

    const result = await requireValue(LIGHTER_ORDER_LIFECYCLE_HANDLERS["lighter.order.cancel"])(
      { intentId },
      FULL_CTX,
    );

    expect(getApproval).not.toHaveBeenCalled();
    expect(getAudit).not.toHaveBeenCalled();
    expect(markApprovalDecision).toHaveBeenCalledWith(expect.objectContaining({
      decision: "approved",
      approvalId: null,
      reason: "auto-approved: session permission is full access",
    }));
    expect(result.pendingApproval).not.toBe(true);
    expect(result.output).toContain("dependencies are unavailable");
  });
});
