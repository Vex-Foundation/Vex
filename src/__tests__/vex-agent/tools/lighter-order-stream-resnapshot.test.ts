import { describe, expect, it, vi } from "vitest";

import type { LighterAccountOrder } from "@tools/lighter/types.js";
import type { LighterOrderExecutionIntentRow } from "@vex-agent/db/repos/lighter-order-execution-intents.js";
import { resnapshotLighterOrderAccount } from "@vex-agent/tools/protocols/lighter/order-stream-resnapshot.js";

function order(status: string, overrides: Partial<LighterAccountOrder> = {}): LighterAccountOrder {
  return {
    order_index: 987,
    client_order_index: 123456,
    order_id: "987",
    client_order_id: "123456",
    market_index: 0,
    owner_account_index: 42,
    initial_base_amount: "1.0",
    price: "2000.00",
    status,
    filled_base_amount: status === "filled" ? "1.0" : "0",
    remaining_base_amount: status === "filled" ? "0" : "1.0",
    ...overrides,
  };
}

function intent(): LighterOrderExecutionIntentRow {
  return {
    intentId: "lighter-exec-00000000-0000-4000-8000-000000000001",
    sessionId: "session-1",
    previewId: "preview-1",
    protocolExecutionId: null,
    approvalId: "approval-1",
    matchHash: "a".repeat(64),
    environment: "rhc",
    accountIndex: 42,
    apiKeyIndex: 7,
    marketIndex: 0,
    side: "buy",
    baseAmountInteger: "100",
    priceInteger: "200000",
    orderType: "limit",
    timeInForce: "good-till-time",
    reduceOnly: false,
    triggerPriceInteger: null,
    orderExpiryMs: 1_800_000_000_000,
    clientOrderIndexPolicy: "vex_assigned_uint48",
    providerVersion: "lighter-order-preview-v1",
    credentialRefJson: {
      kind: "encrypted_vault_reference",
      environment: "rhc",
      accountIndex: 42,
      apiKeyIndex: 7,
      vaultCredentialId: "lighter/rhc/account-42/api-key-7",
    },
    approvalStatus: "approved",
    executionState: "open",
    decisionReason: null,
    decidedAt: null,
    nonceReservationId: "reservation-1",
    nonceValue: "12",
    clientOrderIndex: "123456",
    signerTxHash: "signer-hash",
    submittedTxHash: "submitted-hash",
    submitCode: 200,
    submitMessage: "accepted",
    predictedExecutionTimeMs: 10,
    volumeQuotaRemaining: null,
    ambiguousReason: null,
    signedAt: null,
    submittedAt: null,
    apiAcceptedAt: null,
    ambiguousAt: null,
    providerOrderId: "987",
    providerOrderStatus: "open",
    providerOutcomeSource: "active_order",
    providerOutcomeJson: null,
    providerOutcomeCheckedAt: null,
    preSubmitRevalidationJson: null,
    preSubmitRevalidatedAt: null,
    createdAt: "2026-08-18T00:00:00.000Z",
    updatedAt: "2026-08-18T00:00:00.000Z",
    expiresAt: "2026-08-18T00:05:00.000Z",
  };
}

describe("Lighter order stream reconnect resnapshot", () => {
  it("reads active and inactive orders once and keeps the most advanced exact evidence", async () => {
    const row = intent();
    const markStreamOutcome = vi.fn(async (input: { state: string }) => ({
      ...row,
      executionState: input.state,
    } as LighterOrderExecutionIntentRow));
    const client = {
      getAccountActiveOrders: vi.fn(async () => ({ code: 200, orders: [order("open")] })),
      getAccountInactiveOrders: vi.fn(async () => ({ code: 200, orders: [order("filled")] })),
      getAccountTrades: vi.fn(async () => ({ code: 200, trades: [] })),
      getAccount: vi.fn(async () => ({ code: 200, accounts: [{ index: 42, positions: [] }] })),
      getNextNonce: vi.fn(async () => ({ code: 200, nonce: 13 })),
    };
    const report = await resnapshotLighterOrderAccount(
      "rhc",
      42,
      { token: "deadline:42:7:auth", accountIndex: 42 },
      {
        client,
        reconciliation: {
          orderIntents: {
            listStreamWatchable: vi.fn(async () => [row]),
            markStreamOutcome,
          },
          lifecycleIntents: {
            listStreamWatchable: vi.fn(async () => []),
            markStreamEvidence: vi.fn(async () => null),
          },
          nonceState: {
            find: vi.fn(async () => null),
            recordExecutionObserved: vi.fn(async () => null),
          },
        },
      },
    );

    expect(client.getAccountActiveOrders).toHaveBeenCalledOnce();
    expect(client.getAccountInactiveOrders).toHaveBeenCalledOnce();
    expect(markStreamOutcome).toHaveBeenCalledWith(expect.objectContaining({
      state: "filled",
      source: "inactive_order",
      providerOutcomeJson: expect.objectContaining({
        transport: "account_orders_resnapshot",
      }),
    }));
    expect(report).toMatchObject({
      activeOrders: 1,
      inactiveOrders: 1,
      uniqueOrders: 1,
      trades: 0,
      positions: 0,
      reconciliation: { createOrders: { advanced: 1 } },
    });
  });

  it("rejects auth scoped to a different account before network access", async () => {
    const client = {
      getAccountActiveOrders: vi.fn(),
      getAccountInactiveOrders: vi.fn(),
      getAccountTrades: vi.fn(),
      getAccount: vi.fn(),
      getNextNonce: vi.fn(),
    };

    await expect(resnapshotLighterOrderAccount(
      "rhc",
      42,
      { token: "token", accountIndex: 43 },
      { client },
    )).rejects.toThrow("auth does not match");
    expect(client.getAccountActiveOrders).not.toHaveBeenCalled();
  });
});
