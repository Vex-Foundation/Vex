import { describe, expect, it, vi } from "vitest";

import {
  executeApprovedLighterCancelAll,
  executeApprovedLighterCancelOne,
  executeApprovedLighterClosePosition,
  executeApprovedLighterModifyOrder,
  lifecycleSnapshot,
  prepareLighterCancelAll,
  prepareLighterCancelOne,
  prepareLighterClosePosition,
  prepareLighterModifyOrder,
  type LighterOrderLifecycleExecutionDeps,
} from "@vex-agent/tools/protocols/lighter/order-lifecycle.js";
import type { LighterOrderLifecycleIntentRow } from "@vex-agent/db/repos/lighter-order-lifecycle-intents.js";
import type { LighterAccountOrder, LighterAccountPosition } from "@tools/lighter/types.js";
import { deriveVexAssignedClientOrderIndex } from "@tools/lighter/signer-order.js";

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

const longPosition: LighterAccountPosition = {
  market_id: 0,
  symbol: "ETH",
  initial_margin_fraction: "5.00",
  open_order_count: 0,
  pending_order_count: 0,
  position_tied_order_count: 0,
  sign: 1,
  position: "1.0000",
  avg_entry_price: "45.00",
  position_value: "50.000000",
  unrealized_pnl: "5.000000",
  realized_pnl: "0.000000",
  liquidation_price: "30.00",
  margin_mode: 0,
  allocated_margin: "0.000000",
  total_discount: "0.000000",
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
    providerSnapshotJson: { ...lifecycleSnapshot(openOrder) },
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
      markClosePositionChangedBeforeSubmissionWith: vi.fn().mockResolvedValue(intent({ executionState: "rejected" })),
    },
    nonceState: {
      recordExecutionObserved: vi.fn().mockResolvedValue({ status: "observed" }),
      reserveObservedWith: vi.fn().mockResolvedValue({ reservedNonce: "9", reservationId: `lighter-lifecycle:${intent().intentId}` }),
    },
    transaction: vi.fn(async (fn) => fn({} as never)) as typeof import("@vex-agent/db/client.js").withTransaction,
    acquireSessionControlLock: vi.fn().mockResolvedValue(undefined),
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

describe("Lighter reduce-only position close lifecycle", () => {
  const market = {
    symbol: "ETH",
    market_id: 0,
    market_type: "perp" as const,
    base_asset_id: 1,
    quote_asset_id: 3,
    status: "active" as const,
    taker_fee: "0.00045",
    maker_fee: "0.00010",
    liquidation_fee: "0.005",
    min_base_amount: "0.0001",
    min_quote_amount: "10",
    supported_size_decimals: 4,
    supported_price_decimals: 2,
    supported_quote_decimals: 6,
    order_quote_limit: "1000000",
    is_maker_fee_enabled: true,
    is_taker_fee_enabled: true,
  };
  const bid = {
    order_index: 1,
    order_id: "281474976710657",
    owner_account_index: 99,
    initial_base_amount: "2.0000",
    remaining_base_amount: "2.0000",
    price: "50.00",
    order_expiry: 0,
    transaction_time: NOW,
  };

  it("prepares an exact full-size reduce-only IOC close within explicit slippage", async () => {
    const result = await prepareLighterClosePosition({
      environment: "rhc",
      accountIndex: 42,
      apiKeyIndex: 7,
      marketIndex: 0,
      maxSlippageBps: 100,
      client: {
        getAccount: vi.fn().mockResolvedValue({ code: 200, accounts: [{ index: 42, positions: [longPosition] }] }),
        getMarkets: vi.fn().mockResolvedValue({ code: 200, order_books: [market] }),
        getOrderBookOrders: vi.fn().mockResolvedValue({ code: 200, total_asks: 0, asks: [], total_bids: 1, bids: [bid] }),
      },
    });
    expect(result).toMatchObject({
      closingSide: "sell",
      baseAmount: "1",
      baseAmountInteger: "10000",
      worstAcceptablePrice: "49.5",
      priceInteger: "4950",
      maxSlippageBps: 100,
    });
    expect(result.matchHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("refuses to prepare when visible depth cannot close the full position", async () => {
    await expect(prepareLighterClosePosition({
      environment: "rhc",
      accountIndex: 42,
      apiKeyIndex: 7,
      marketIndex: 0,
      maxSlippageBps: 100,
      client: {
        getAccount: vi.fn().mockResolvedValue({ code: 200, accounts: [{ index: 42, positions: [longPosition] }] }),
        getMarkets: vi.fn().mockResolvedValue({ code: 200, order_books: [market] }),
        getOrderBookOrders: vi.fn().mockResolvedValue({
          code: 200, total_asks: 0, asks: [], total_bids: 1,
          bids: [{ ...bid, remaining_base_amount: "0.5000" }],
        }),
      },
    })).rejects.toThrow("cannot close the full position");
  });

  it("submits once and reports exact fill plus resulting flat position", async () => {
    const dependencies = deps();
    const matchHash = "d".repeat(64);
    const clientOrderId = deriveVexAssignedClientOrderIndex(matchHash);
    const closeOrder: LighterAccountOrder = {
      ...openOrder,
      order_id: "281474976710658",
      client_order_id: clientOrderId,
      client_order_index: Number(clientOrderId),
      initial_base_amount: "1.0000",
      remaining_base_amount: "0.0000",
      filled_base_amount: "1.0000",
      filled_quote_amount: "49.75",
      price: "49.50",
      side: "sell",
      type: "market",
      time_in_force: "immediate-or-cancel",
      reduce_only: true,
      status: "filled",
    };
    Object.assign(dependencies.client, {
      getAccount: vi.fn()
        .mockResolvedValueOnce({
          code: 200,
          accounts: [{
            index: 42,
            positions: [{
              ...longPosition,
              position_value: "50.250000",
              unrealized_pnl: "5.250000",
              liquidation_price: "30.01",
            }],
          }],
        })
        .mockResolvedValue({ code: 200, accounts: [{ index: 42, positions: [{ ...longPosition, position: "0.0000" }] }] }),
      getMarkets: vi.fn().mockResolvedValue({ code: 200, order_books: [market] }),
      getOrderBookOrders: vi.fn().mockResolvedValue({ code: 200, total_asks: 0, asks: [], total_bids: 1, bids: [bid] }),
      getAccountTrades: vi.fn().mockResolvedValue({ code: 200, trades: [] }),
    });
    vi.mocked(dependencies.client.getAccountInactiveOrders).mockResolvedValue({ code: 200, orders: [closeOrder] });
    vi.mocked(dependencies.client.sendTx).mockResolvedValue({
      code: 200, tx_hash: "hash-14", predicted_execution_time_ms: 100, volume_quota_remaining: 99,
    });
    vi.mocked(dependencies.authSigner.signCreateOrder).mockImplementation(async (input) => ({
      kind: "lighter_create_order_signer_result",
      environment: "rhc",
      accountIndex: 42,
      apiKeyIndex: 7,
      nonce: "9",
      clientOrderIndex: input.order.clientOrderIndex,
      matchHash: input.order.matchHash,
      txType: 14,
      txInfo: "signed-close",
      txHash: "hash-14",
    }));
    const closeIntent = intent({
      actionType: "close_position",
      matchHash,
      marketIndex: 0,
      providerOrderId: null,
      requestedBaseAmountInteger: "10000",
      requestedPriceInteger: "4950",
      requestedSide: "sell",
      reduceOnly: true,
      providerSnapshotJson: {
        position: {
          marketIndex: 0, symbol: "ETH", sign: 1, side: "long", position: "1.0000",
          averageEntryPrice: "45.00", positionValue: "50.000000", unrealizedPnl: "5.000000",
          liquidationPrice: "30.00",
        },
        marketSizeDecimals: 4,
        marketPriceDecimals: 2,
        maxSlippageBps: 100,
      },
    });
    const result = await executeApprovedLighterClosePosition(closeIntent, dependencies);
    expect(result).toMatchObject({
      status: "closed",
      clientOrderId,
      providerOrderId: "281474976710658",
      executedAmount: "1.0000",
      remainingOrderAmount: "0.0000",
      averageFillPrice: "49.75",
      resultingPosition: null,
    });
    expect(dependencies.authSigner.signCreateOrder).toHaveBeenCalledWith(expect.objectContaining({
      order: expect.objectContaining({
        orderTypeCode: 1,
        timeInForceCode: 0,
        reduceOnly: true,
        isAsk: true,
        baseAmountInteger: "10000",
        priceInteger: "4950",
      }),
    }));
    expect(dependencies.intents.markSigned).toHaveBeenCalledWith(expect.objectContaining({
      signerExpiryMs: null,
    }));
    expect(dependencies.client.sendTx).toHaveBeenCalledTimes(1);
  });

  it("terminalizes a true position-size drift before nonce reservation or signing", async () => {
    const dependencies = deps();
    Object.assign(dependencies.client, {
      getAccount: vi.fn().mockResolvedValue({
        code: 200,
        accounts: [{ index: 42, positions: [{ ...longPosition, position: "0.9000" }] }],
      }),
      getMarkets: vi.fn().mockResolvedValue({ code: 200, order_books: [market] }),
      getOrderBookOrders: vi.fn().mockResolvedValue({
        code: 200, total_asks: 0, asks: [], total_bids: 1, bids: [bid],
      }),
    });
    const closeIntent = intent({
      actionType: "close_position",
      marketIndex: 0,
      providerOrderId: null,
      requestedBaseAmountInteger: "10000",
      requestedPriceInteger: "4950",
      requestedSide: "sell",
      reduceOnly: true,
      providerSnapshotJson: {
        position: {
          marketIndex: 0, symbol: "ETH", sign: 1, side: "long", position: "1.0000",
          averageEntryPrice: "45.00", positionValue: "50.000000", unrealizedPnl: "5.000000",
          liquidationPrice: "30.00",
        },
        marketSizeDecimals: 4,
        marketPriceDecimals: 2,
        maxSlippageBps: 100,
      },
    });

    await expect(executeApprovedLighterClosePosition(closeIntent, dependencies))
      .rejects.toThrow("No lifecycle transaction was signed or submitted");

    expect(dependencies.intents.markClosePositionChangedBeforeSubmissionWith).toHaveBeenCalledWith(
      expect.anything(),
      { intentId: closeIntent.intentId, sessionId: closeIntent.sessionId },
    );
    expect(dependencies.acquireSessionControlLock).toHaveBeenCalledWith(
      expect.anything(),
      closeIntent.sessionId,
    );
    expect(dependencies.intents.markPreSubmitRevalidated).not.toHaveBeenCalled();
    expect(dependencies.nonceState.reserveObservedWith).not.toHaveBeenCalled();
    expect(dependencies.authSigner.signCreateOrder).not.toHaveBeenCalled();
    expect(dependencies.client.sendTx).not.toHaveBeenCalled();
  });
});
