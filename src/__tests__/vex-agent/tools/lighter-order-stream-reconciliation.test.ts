import { describe, expect, it, vi } from "vitest";

import type { LighterAccountAllOrdersStreamMessage, LighterAccountOrder } from "@tools/lighter/types.js";
import type { LighterOrderExecutionIntentRow } from "@vex-agent/db/repos/lighter-order-execution-intents.js";
import {
  classifyLighterStreamOrderState,
  reconcileLighterOrderStreamMessage,
  type LighterOrderStreamReconciliationDeps,
} from "@vex-agent/tools/protocols/lighter/order-stream-reconciliation.js";

const INTENT_ID = "lighter-exec-00000000-0000-4000-8000-000000000001";

function intent(
  overrides: Partial<LighterOrderExecutionIntentRow> = {},
): LighterOrderExecutionIntentRow {
  return {
    intentId: INTENT_ID,
    sessionId: "session-1",
    previewId: "lighter-preview-1",
    protocolExecutionId: null,
    approvalId: "approval-1",
    matchHash: "a".repeat(64),
    environment: "rhc",
    accountIndex: 42,
    apiKeyIndex: 7,
    marketIndex: 0,
    side: "buy",
    baseAmountInteger: "10000",
    priceInteger: "300000",
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
    executionState: "sequencer_pending",
    decisionReason: null,
    decidedAt: null,
    nonceReservationId: `lighter-order:${INTENT_ID}`,
    nonceValue: "1200",
    clientOrderIndex: "123456",
    signerTxHash: "signer-hash",
    submittedTxHash: "submitted-hash",
    submitCode: 200,
    submitMessage: "accepted",
    predictedExecutionTimeMs: 10,
    volumeQuotaRemaining: null,
    ambiguousReason: null,
    signedAt: "2026-08-18T00:00:00.000Z",
    submittedAt: "2026-08-18T00:00:01.000Z",
    apiAcceptedAt: "2026-08-18T00:00:02.000Z",
    ambiguousAt: null,
    providerOrderId: null,
    providerOrderStatus: null,
    providerOutcomeSource: null,
    providerOutcomeJson: null,
    providerOutcomeCheckedAt: null,
    preSubmitRevalidationJson: {
      kind: "lighter_order_pre_submit_revalidation",
      baseDecimals: 4,
      priceDecimals: 2,
    },
    preSubmitRevalidatedAt: null,
    createdAt: "2026-08-18T00:00:00.000Z",
    updatedAt: "2026-08-18T00:00:02.000Z",
    expiresAt: "2026-08-18T00:05:00.000Z",
    ...overrides,
  };
}

function order(overrides: Partial<LighterAccountOrder> = {}): LighterAccountOrder {
  return {
    order_index: 987,
    client_order_index: 123456,
    order_id: "987",
    client_order_id: "123456",
    market_index: 0,
    owner_account_index: 42,
    initial_base_amount: "1.0",
    price: "3000.00",
    order_expiry: 1_800_000_000_000,
    status: "open",
    filled_base_amount: "0",
    remaining_base_amount: "1.0",
    ...overrides,
  };
}

function frame(orders: readonly LighterAccountOrder[]): LighterAccountAllOrdersStreamMessage {
  return {
    type: "update/account_all_orders",
    channel: "account_all_orders:42",
    orders: { "0": orders },
  };
}

function deps(rows: readonly LighterOrderExecutionIntentRow[] = [intent()]) {
  const mock = {
    client: {
      getNextNonce: vi.fn(async () => ({ code: 200, nonce: 1201 })),
    },
    intents: {
      listStreamWatchable: vi.fn(async () => [...rows]),
      markStreamOutcome: vi.fn(async (input: { state: LighterOrderExecutionIntentRow["executionState"] }) =>
        intent({ executionState: input.state })),
      markEvidenceConflict: vi.fn(async () => intent({
        executionState: "ambiguous",
        ambiguousReason: "provider_order_semantic_conflict",
      })),
    },
    nonceState: {
      find: vi.fn(async () => ({
        environment: "rhc" as const,
        accountIndex: 42,
        apiKeyIndex: 7,
        providerNonce: "1200",
        publicKey: "ab".repeat(20),
        providerTransactionTime: null,
        status: "reserved" as const,
        reservedNonce: "1200",
        reservationId: `lighter-order:${INTENT_ID}`,
        source: "live_lighter_public_api" as const,
        observedAt: "2026-08-18T00:00:00.000Z",
        updatedAt: "2026-08-18T00:00:00.000Z",
      })),
      recordExecutionObserved: vi.fn(async () => null),
    },
  };
  return mock as typeof mock & LighterOrderStreamReconciliationDeps;
}

describe("Lighter order stream reconciliation", () => {
  it("advances an exact client order to filled and refreshes its nonce scope", async () => {
    const d = deps();
    const report = await reconcileLighterOrderStreamMessage(
      "rhc",
      42,
      frame([order({
        side: "",
        is_ask: false,
        status: "filled",
        filled_base_amount: "1.0",
        remaining_base_amount: "0",
      })]),
      d,
    );

    expect(report).toMatchObject({ matched: 1, advanced: 1, nonceScopesRefreshed: 1 });
    expect(d.intents.markStreamOutcome).toHaveBeenCalledWith(expect.objectContaining({
      intentId: INTENT_ID,
      state: "filled",
      source: "inactive_order",
      providerOrderId: "987",
      providerOutcomeJson: expect.objectContaining({
        transport: "account_all_orders_stream",
        clientOrderIndex: "123456",
      }),
    }));
    expect(d.nonceState.recordExecutionObserved).toHaveBeenCalledWith(expect.objectContaining({
      nonce: 1201,
    }));
  });

  it("keeps open orders watchable and recognizes partial fills", async () => {
    const d = deps([intent({ executionState: "open" })]);
    const report = await reconcileLighterOrderStreamMessage(
      "rhc",
      42,
      frame([order({ status: "open", filled_base_amount: "0.25" })]),
      d,
    );

    expect(report.advanced).toBe(1);
    expect(d.intents.markStreamOutcome).toHaveBeenCalledWith(expect.objectContaining({
      state: "partially_filled",
      source: "active_order",
    }));
  });

  it.each(["canceled", "canceled-expired", "expired"])(
    "reports terminal %s orders with a positive fill as partially filled",
    async (status) => {
      const d = deps();
      const report = await reconcileLighterOrderStreamMessage(
        "rhc",
        42,
        frame([order({ status, filled_base_amount: "0.25", remaining_base_amount: "0.75" })]),
        d,
      );

      expect(report.advanced).toBe(1);
      expect(d.intents.markStreamOutcome).toHaveBeenCalledWith(expect.objectContaining({
        state: "partially_filled",
        source: "inactive_order",
        providerOrderStatus: status,
      }));
    },
  );

  it("never infers an outcome from an order missing from the frame", async () => {
    const d = deps();
    const report = await reconcileLighterOrderStreamMessage("rhc", 42, frame([]), d);

    expect(report).toMatchObject({ examined: 1, matched: 0, advanced: 0 });
    expect(d.intents.markStreamOutcome).not.toHaveBeenCalled();
    expect(d.client.getNextNonce).not.toHaveBeenCalled();
  });

  it("durably marks ambiguous when provider price contradicts the approved canonical terms", async () => {
    const d = deps();
    const report = await reconcileLighterOrderStreamMessage(
      "rhc",
      42,
      frame([order({ price: "3000.01", status: "filled" })]),
      d,
    );

    expect(report).toMatchObject({ matched: 0, advanced: 0, evidenceConflicts: 1 });
    expect(d.intents.markStreamOutcome).not.toHaveBeenCalled();
    expect(d.intents.markEvidenceConflict).toHaveBeenCalledWith({
      intentId: INTENT_ID,
      environment: "rhc",
      reason: "provider_order_semantic_conflict",
    });
    expect(d.client.getNextNonce).not.toHaveBeenCalled();
  });

  it("durably marks ambiguous when one stream frame repeats the exact client-order identity", async () => {
    const d = deps();
    const report = await reconcileLighterOrderStreamMessage(
      "rhc",
      42,
      frame([order(), order({ order_id: "988", status: "filled" })]),
      d,
    );

    expect(report).toMatchObject({ matched: 0, advanced: 0, evidenceConflicts: 1 });
    expect(d.intents.markStreamOutcome).not.toHaveBeenCalled();
    expect(d.intents.markEvidenceConflict).toHaveBeenCalledWith({
      intentId: INTENT_ID,
      environment: "rhc",
      reason: "provider_order_duplicate_identity_conflict",
    });
    expect(d.client.getNextNonce).not.toHaveBeenCalled();
  });

  it("does not confirm old rows missing persisted decimal precision", async () => {
    const d = deps([intent({ preSubmitRevalidationJson: null })]);
    const report = await reconcileLighterOrderStreamMessage("rhc", 42, frame([order()]), d);

    expect(report).toMatchObject({ matched: 0, advanced: 0 });
    expect(d.intents.markStreamOutcome).not.toHaveBeenCalled();
  });

  it("ignores undocumented statuses rather than guessing", async () => {
    const d = deps();
    const report = await reconcileLighterOrderStreamMessage(
      "rhc",
      42,
      frame([order({ status: "provider-added-status" })]),
      d,
    );

    expect(report).toMatchObject({ matched: 1, unknownStatus: 1, advanced: 0 });
    expect(d.intents.markStreamOutcome).not.toHaveBeenCalled();
  });

  it("deduplicates identical stream evidence and avoids repeated nonce reads", async () => {
    const row = intent({
      executionState: "open",
      providerOrderId: "987",
      providerOrderStatus: "open",
      providerOutcomeSource: "active_order",
      providerOutcomeJson: {
        source: "active_order",
        transport: "account_all_orders_stream",
        remainingBaseAmount: "1.0",
        filledBaseAmount: "0",
        filledQuoteAmount: null,
      },
    });
    const d = deps([row]);
    const report = await reconcileLighterOrderStreamMessage("rhc", 42, frame([order()]), d);

    expect(report).toMatchObject({ deduplicated: 1, advanced: 0 });
    expect(d.intents.markStreamOutcome).not.toHaveBeenCalled();
    expect(d.client.getNextNonce).not.toHaveBeenCalled();
  });

  it("retains durable order evidence when the public nonce refresh fails", async () => {
    const d = deps();
    d.client.getNextNonce.mockRejectedValueOnce(new Error("unreachable"));
    const report = await reconcileLighterOrderStreamMessage(
      "rhc",
      42,
      frame([order({ status: "filled" })]),
      d,
    );

    expect(report).toMatchObject({ advanced: 1, nonceRefreshFailures: 1 });
  });

  it("classifies only the exact status vocabulary documented by Lighter", () => {
    expect(classifyLighterStreamOrderState(order({ status: "pending" }))).toBe("sequencer_pending");
    expect(classifyLighterStreamOrderState(order({ status: "in-progress" }))).toBe("sequencer_pending");
    expect(classifyLighterStreamOrderState(order({ status: "canceled-expired" }))).toBe("canceled");
    expect(classifyLighterStreamOrderState(order({ status: "expired" }))).toBe("canceled");
    expect(classifyLighterStreamOrderState(order({ status: "rejected" }))).toBeNull();
  });
});
