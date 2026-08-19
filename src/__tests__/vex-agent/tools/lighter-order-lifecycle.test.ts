import { describe, expect, it, vi } from "vitest";

import {
  executeApprovedLighterCancelAll,
  executeApprovedLighterCancelOne,
  executeApprovedLighterModifyOrder,
  lifecycleSnapshot,
  prepareLighterCancelAll,
  prepareLighterCancelOne,
  prepareLighterModifyOrder,
  type LighterOrderLifecycleExecutionDeps,
} from "@vex-agent/tools/protocols/lighter/order-lifecycle.js";
import type { LighterOrderLifecycleIntentRow } from "@vex-agent/db/repos/lighter-order-lifecycle-intents.js";
import type { LighterAccountOrder } from "@tools/lighter/types.js";

const NOW = Date.parse("2026-08-19T20:00:00.000Z");
const PRIVATE_KEY = "1".repeat(80);

const openOrder: LighterAccountOrder = {
  order_index: 9_007_199_254_740_991,
  client_order_index: 123,
  order_id: "1152921504606846975",
  client_order_id: "123",
  market_index: 0,
  owner_account_index: 42,
  initial_base_amount: "1",
  remaining_base_amount: "0.5",
  filled_base_amount: "0.5",
  filled_quote_amount: "25",
  price: "50",
  side: "buy",
  type: "limit",
  time_in_force: "good-till-time",
  reduce_only: false,
  status: "open",
};

function intent(overrides: Partial<LighterOrderLifecycleIntentRow> = {}): LighterOrderLifecycleIntentRow {
  return {
    intentId: `lighter-lifecycle-${"a".repeat(32)}`,
    sessionId: "session-1",
    protocolExecutionId: null,
    approvalId: "approval-1",
    matchHash: "b".repeat(64),
    environment: "rhc",
    accountIndex: 42,
    apiKeyIndex: 7,
    actionType: "cancel_one",
    marketIndex: 0,
    providerOrderId: openOrder.order_id,
    requestedBaseAmountInteger: null,
    requestedPriceInteger: null,
    requestedSide: null,
    reduceOnly: false,
    providerSnapshotJson: lifecycleSnapshot(openOrder),
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
    ...overrides,
  };
}

function deps(overrides: Partial<LighterOrderLifecycleExecutionDeps> = {}): LighterOrderLifecycleExecutionDeps {
  const active = vi.fn()
    .mockResolvedValueOnce({ code: 200, orders: [openOrder] })
    .mockResolvedValue({ code: 200, orders: [] });
  const canceledOrder = { ...openOrder, status: "canceled", remaining_base_amount: "0.5" };
  return {
    secretReader: { readTradingApiPrivateKey: vi.fn().mockResolvedValue(PRIVATE_KEY) },
    authSigner: {
      source: "official_lighter_signer",
      createAccountAuth: vi.fn().mockResolvedValue({
        kind: "lighter_account_auth_signer_result",
        environment: "rhc",
        accountIndex: 42,
        apiKeyIndex: 7,
        deadlineUnixSeconds: Math.floor(NOW / 1_000) + 600,
        authToken: `${Math.floor(NOW / 1_000) + 600}:42:7:${"a".repeat(128)}`,
        publicKey: "b".repeat(80),
      }),
      signCreateOrder: vi.fn(),
    },
    lifecycleSigner: {
      source: "official_lighter_signer",
      signCancelOrder: vi.fn().mockResolvedValue({
        kind: "lighter_order_lifecycle_signer_result",
        operation: "cancel_order",
        environment: "rhc",
        accountIndex: 42,
        apiKeyIndex: 7,
        nonce: "9",
        expiredAt: String(NOW + 60_000),
        txType: 15,
        txInfo: "signed-cancel",
        txHash: "hash-15",
      }),
      signModifyOrder: vi.fn().mockResolvedValue({
        kind: "lighter_order_lifecycle_signer_result",
        operation: "modify_order",
        environment: "rhc",
        accountIndex: 42,
        apiKeyIndex: 7,
        nonce: "9",
        expiredAt: String(NOW + 60_000),
        txType: 17,
        txInfo: "signed-modify",
        txHash: "hash-17",
      }),
      signCancelAllOrders: vi.fn().mockResolvedValue({
        kind: "lighter_order_lifecycle_signer_result",
        operation: "cancel_all_orders",
        environment: "rhc",
        accountIndex: 42,
        apiKeyIndex: 7,
        nonce: "9",
        expiredAt: String(NOW + 60_000),
        txType: 16,
        txInfo: "signed-cancel-all",
        txHash: "hash-16",
      }),
    },
    client: {
      getAccountActiveOrders: active,
      getAccountInactiveOrders: vi.fn().mockResolvedValue({ code: 200, orders: [canceledOrder] }),
      getMarkets: vi.fn().mockResolvedValue({
        code: 200,
        order_books: [{ market_id: 0, status: "active", supported_size_decimals: 4, supported_price_decimals: 2 }],
      }),
      getApiKeys: vi.fn().mockResolvedValue({ code: 200, api_keys: [{
        account_index: 42, api_key_index: 7, nonce: 9, public_key: "b".repeat(80), transaction_time: NOW,
      }] }),
      getNextNonce: vi.fn().mockResolvedValue({ code: 200, nonce: 9 }),
      sendTx: vi.fn().mockResolvedValue({
        code: 200, tx_hash: "hash-15", predicted_execution_time_ms: 100, volume_quota_remaining: 99,
      }),
    },
    intents: {
      markPreSubmitRevalidated: vi.fn().mockResolvedValue(intent({ executionState: "pre_submit_revalidated" })),
      attachNonceReservationWith: vi.fn().mockResolvedValue(intent({ executionState: "nonce_reserved" })),
      markSigned: vi.fn().mockResolvedValue(intent({ executionState: "signed" })),
      markSubmissionStaged: vi.fn().mockResolvedValue(intent({ executionState: "submission_staged" })),
      markApiAccepted: vi.fn().mockResolvedValue(intent({ executionState: "api_accepted" })),
      markProviderOutcome: vi.fn().mockResolvedValue(intent({ executionState: "completed" })),
      markAmbiguous: vi.fn().mockResolvedValue(intent({ executionState: "ambiguous" })),
    },
    nonceState: {
      recordExecutionObserved: vi.fn().mockResolvedValue({ status: "observed" }),
      reserveObservedWith: vi.fn().mockResolvedValue({ reservedNonce: "9", reservationId: `lighter-lifecycle:${intent().intentId}` }),
    },
    transaction: vi.fn(async (fn) => fn({} as never)) as typeof import("@vex-agent/db/client.js").withTransaction,
    now: () => NOW,
    wait: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as LighterOrderLifecycleExecutionDeps;
}

describe("Lighter cancel-one lifecycle", () => {
  it("prepares only an exact active provider order and hashes its immutable snapshot", async () => {
    const result = await prepareLighterCancelOne({
      environment: "rhc",
      accountIndex: 42,
      apiKeyIndex: 7,
      marketIndex: 0,
      providerOrderId: openOrder.order_id,
      auth: { token: "read-token", accountIndex: 42 },
      client: { getAccountActiveOrders: vi.fn().mockResolvedValue({ code: 200, orders: [openOrder] }) },
    });
    expect(result.providerOrderId).toBe("1152921504606846975");
    expect(result.snapshot.orderId).toBe("1152921504606846975");
    expect(result.matchHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("stages once and reports cancellation only from exact inactive-order evidence", async () => {
    const dependencies = deps();
    const result = await executeApprovedLighterCancelOne(intent(), dependencies);
    expect(result).toMatchObject({
      status: "canceled",
      providerOrderId: openOrder.order_id,
      executedAmount: "0.5",
      remainingAmount: "0.5",
      averageFillPrice: "50",
    });
    expect(dependencies.client.sendTx).toHaveBeenCalledTimes(1);
    expect(dependencies.intents.markSubmissionStaged).toHaveBeenCalledBefore(
      dependencies.client.sendTx as ReturnType<typeof vi.fn>,
    );
  });

  it("never retries an ambiguous provider submission", async () => {
    const dependencies = deps();
    vi.mocked(dependencies.client.sendTx).mockRejectedValueOnce(new Error("timeout"));
    const result = await executeApprovedLighterCancelOne(intent(), dependencies);
    expect(result).toMatchObject({ status: "ambiguous", reason: "send_tx_transport_ambiguous" });
    expect(dependencies.client.sendTx).toHaveBeenCalledTimes(1);
    expect(dependencies.intents.markAmbiguous).toHaveBeenCalledWith({
      intentId: intent().intentId,
      reason: "send_tx_transport_ambiguous",
    });
  });

  it("blocks changed order facts before nonce reservation", async () => {
    const dependencies = deps();
    vi.mocked(dependencies.client.getAccountActiveOrders).mockReset().mockResolvedValue({
      code: 200,
      orders: [{ ...openOrder, remaining_base_amount: "0.4" }],
    });
    await expect(executeApprovedLighterCancelOne(intent(), dependencies)).rejects.toThrow(
      "changed before cancel submission",
    );
    expect(dependencies.nonceState.reserveObservedWith).not.toHaveBeenCalled();
    expect(dependencies.client.sendTx).not.toHaveBeenCalled();
  });
});

describe("Lighter modify-order lifecycle", () => {
  it("prepares human amounts at live market precision and binds the original order", async () => {
    const result = await prepareLighterModifyOrder({
      environment: "rhc",
      accountIndex: 42,
      apiKeyIndex: 7,
      marketIndex: 0,
      providerOrderId: openOrder.order_id,
      requestedBaseAmount: "0.75",
      requestedPrice: "51.25",
      sizeDecimals: 4,
      priceDecimals: 2,
      auth: { token: "read-token", accountIndex: 42 },
      client: { getAccountActiveOrders: vi.fn().mockResolvedValue({ code: 200, orders: [openOrder] }) },
    });
    expect(result).toMatchObject({
      providerOrderId: openOrder.order_id,
      requestedBaseAmount: "0.75",
      requestedBaseAmountInteger: "7500",
      requestedPrice: "51.25",
      requestedPriceInteger: "5125",
    });
    expect(result.matchHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("refuses a new total amount below what is already filled", async () => {
    await expect(prepareLighterModifyOrder({
      environment: "rhc",
      accountIndex: 42,
      apiKeyIndex: 7,
      marketIndex: 0,
      providerOrderId: openOrder.order_id,
      requestedBaseAmount: "0.4",
      requestedPrice: "51",
      sizeDecimals: 4,
      priceDecimals: 2,
      client: { getAccountActiveOrders: vi.fn().mockResolvedValue({ code: 200, orders: [openOrder] }) },
    })).rejects.toThrow("below the amount already filled");
  });

  it("submits once and completes only from exact updated provider evidence", async () => {
    const modifiedOrder = {
      ...openOrder,
      initial_base_amount: "0.75",
      remaining_base_amount: "0.25",
      price: "51.25",
    };
    const dependencies = deps();
    vi.mocked(dependencies.client.getAccountActiveOrders)
      .mockReset()
      .mockResolvedValueOnce({ code: 200, orders: [openOrder] })
      .mockResolvedValue({ code: 200, orders: [modifiedOrder] });
    vi.mocked(dependencies.client.getAccountInactiveOrders).mockResolvedValue({ code: 200, orders: [] });
    vi.mocked(dependencies.client.sendTx).mockResolvedValue({
      code: 200, tx_hash: "hash-17", predicted_execution_time_ms: 100, volume_quota_remaining: 99,
    });
    const modifyIntent = intent({
      actionType: "modify",
      requestedBaseAmountInteger: "7500",
      requestedPriceInteger: "5125",
      providerSnapshotJson: {
        ...lifecycleSnapshot(openOrder),
        marketSizeDecimals: 4,
        marketPriceDecimals: 2,
      },
    });
    const result = await executeApprovedLighterModifyOrder(modifyIntent, dependencies);
    expect(result).toMatchObject({
      status: "modified",
      providerOrderId: openOrder.order_id,
      effectiveBaseAmount: "0.75",
      effectivePrice: "51.25",
      executedAmount: "0.5",
      remainingAmount: "0.25",
    });
    expect(dependencies.lifecycleSigner.signModifyOrder).toHaveBeenCalledWith(expect.objectContaining({
      providerOrderId: openOrder.order_id,
      baseAmountInteger: "7500",
      priceInteger: "5125",
    }));
    expect(dependencies.client.sendTx).toHaveBeenCalledTimes(1);
  });

  it("blocks a changed order before reserving a modify nonce", async () => {
    const dependencies = deps();
    vi.mocked(dependencies.client.getAccountActiveOrders).mockReset().mockResolvedValue({
      code: 200,
      orders: [{ ...openOrder, remaining_base_amount: "0.4" }],
    });
    const modifyIntent = intent({
      actionType: "modify",
      requestedBaseAmountInteger: "7500",
      requestedPriceInteger: "5125",
      providerSnapshotJson: {
        ...lifecycleSnapshot(openOrder),
        marketSizeDecimals: 4,
        marketPriceDecimals: 2,
      },
    });
    await expect(executeApprovedLighterModifyOrder(modifyIntent, dependencies)).rejects.toThrow(
      "changed before modify submission",
    );
    expect(dependencies.nonceState.reserveObservedWith).not.toHaveBeenCalled();
    expect(dependencies.client.sendTx).not.toHaveBeenCalled();
  });
});

describe("Lighter cancel-all lifecycle", () => {
  const secondOrder: LighterAccountOrder = {
    ...openOrder,
    order_id: "281474976710657",
    client_order_id: "124",
    client_order_index: 124,
    market_index: 1,
    initial_base_amount: "2",
    remaining_base_amount: "2",
    filled_base_amount: "0",
    filled_quote_amount: "0",
    price: "25",
  };

  it("prepares and hashes the complete exact active-order set", async () => {
    const result = await prepareLighterCancelAll({
      environment: "rhc",
      accountIndex: 42,
      apiKeyIndex: 7,
      auth: { token: "read-token", accountIndex: 42 },
      client: { getAccountActiveOrders: vi.fn().mockResolvedValue({ code: 200, orders: [secondOrder, openOrder] }) },
    });
    expect(result.orders.map((order) => order.orderId)).toEqual([openOrder.order_id, secondOrder.order_id]);
    expect(result.matchHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("submits immediate account-wide cancel once and proves every approved order terminal", async () => {
    const dependencies = deps();
    vi.mocked(dependencies.client.getAccountActiveOrders)
      .mockReset()
      .mockResolvedValueOnce({ code: 200, orders: [secondOrder, openOrder] })
      .mockResolvedValue({ code: 200, orders: [] });
    vi.mocked(dependencies.client.getAccountInactiveOrders).mockResolvedValue({
      code: 200,
      orders: [
        { ...openOrder, status: "canceled" },
        { ...secondOrder, status: "filled", remaining_base_amount: "0", filled_base_amount: "2", filled_quote_amount: "50" },
      ],
    });
    vi.mocked(dependencies.client.sendTx).mockResolvedValue({
      code: 200, tx_hash: "hash-16", predicted_execution_time_ms: 100, volume_quota_remaining: 99,
    });
    const approvedOrders = [lifecycleSnapshot(openOrder), lifecycleSnapshot(secondOrder)];
    const cancelAllIntent = intent({
      actionType: "cancel_all",
      marketIndex: null,
      providerOrderId: null,
      providerSnapshotJson: { orders: approvedOrders, orderCount: approvedOrders.length },
    });
    const result = await executeApprovedLighterCancelAll(cancelAllIntent, dependencies);
    expect(result).toMatchObject({
      status: "cancel_all_completed",
      canceledOrderCount: 1,
      filledBeforeCancelCount: 1,
    });
    expect(dependencies.lifecycleSigner.signCancelAllOrders).toHaveBeenCalledWith(expect.objectContaining({
      timeInForce: 0,
      cancelAtMs: "0",
    }));
    expect(dependencies.client.sendTx).toHaveBeenCalledTimes(1);
  });

  it("blocks when the account-wide active set changes before nonce reservation", async () => {
    const dependencies = deps();
    vi.mocked(dependencies.client.getAccountActiveOrders).mockReset().mockResolvedValue({
      code: 200,
      orders: [openOrder],
    });
    const cancelAllIntent = intent({
      actionType: "cancel_all",
      marketIndex: null,
      providerOrderId: null,
      providerSnapshotJson: { orders: [lifecycleSnapshot(openOrder), lifecycleSnapshot(secondOrder)], orderCount: 2 },
    });
    await expect(executeApprovedLighterCancelAll(cancelAllIntent, dependencies)).rejects.toThrow(
      "active-order set changed",
    );
    expect(dependencies.nonceState.reserveObservedWith).not.toHaveBeenCalled();
    expect(dependencies.client.sendTx).not.toHaveBeenCalled();
  });
});
