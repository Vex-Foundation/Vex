import { describe, expect, it, vi } from "vitest";

import { deriveVexAssignedClientOrderIndex } from "@tools/lighter/signer-order.js";
import type {
  LighterAccountAllOrdersStreamMessage,
  LighterAccountAllPositionsStreamMessage,
  LighterAccountAllTradesStreamMessage,
  LighterAccountOrder,
  LighterAccountPosition,
} from "@tools/lighter/types.js";
import type { LighterOrderLifecycleIntentRow } from "@vex-agent/db/repos/lighter-order-lifecycle-intents.js";
import type { LighterOrderExecutionIntentRow } from "@vex-agent/db/repos/lighter-order-execution-intents.js";
import {
  reconcileLighterAccountStreamMessage,
  type LighterAccountStreamReconciliationDeps,
} from "@vex-agent/tools/protocols/lighter/account-stream-reconciliation.js";

const ORDER_ID = "1152921504606846975";

function lifecycleIntent(
  overrides: Partial<LighterOrderLifecycleIntentRow> = {},
): LighterOrderLifecycleIntentRow {
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
    providerOrderId: ORDER_ID,
    requestedBaseAmountInteger: null,
    requestedPriceInteger: null,
    requestedSide: null,
    reduceOnly: false,
    providerSnapshotJson: {},
    credentialRefJson: {
      kind: "encrypted_vault_reference",
      environment: "rhc",
      accountIndex: 42,
      apiKeyIndex: 7,
      vaultCredentialId: "lighter/rhc/account-42/api-key-7",
    },
    approvalStatus: "approved",
    executionState: "sequencer_pending",
    decisionReason: "approved",
    decidedAt: "2026-08-19T20:00:00.000Z",
    preSubmitRevalidationJson: null,
    preSubmitRevalidatedAt: null,
    nonceReservationId: "lighter-lifecycle:one",
    nonceValue: "9",
    signerExpiryMs: 1_800_000_000_000,
    signerTxHash: "signer-hash",
    submittedTxHash: "submitted-hash",
    submitCode: 200,
    submitMessage: "accepted",
    predictedExecutionTimeMs: 10,
    volumeQuotaRemaining: null,
    providerOutcomeJson: null,
    providerOutcomeCheckedAt: null,
    ambiguousReason: null,
    createdAt: "2026-08-19T19:59:00.000Z",
    updatedAt: "2026-08-19T20:00:00.000Z",
    expiresAt: "2026-08-19T20:05:00.000Z",
    ...overrides,
  };
}

function order(overrides: Partial<LighterAccountOrder> = {}): LighterAccountOrder {
  return {
    order_index: Number.MAX_SAFE_INTEGER,
    client_order_index: 123,
    order_id: ORDER_ID,
    client_order_id: "123",
    market_index: 0,
    owner_account_index: 42,
    initial_base_amount: "1.0000",
    remaining_base_amount: "0",
    filled_base_amount: "1.0000",
    filled_quote_amount: "50.000000",
    price: "50.00",
    side: "buy",
    status: "canceled",
    ...overrides,
  };
}

function orderFrame(orders: readonly LighterAccountOrder[]): LighterAccountAllOrdersStreamMessage {
  return {
    type: "update/account_all_orders",
    channel: "account_all_orders:42",
    orders: { "0": orders },
  };
}

function position(value = "0"): LighterAccountPosition {
  return {
    market_id: 0,
    symbol: "ETH",
    initial_margin_fraction: "5.00",
    open_order_count: 0,
    pending_order_count: 0,
    position_tied_order_count: 0,
    sign: 1,
    position: value,
    avg_entry_price: value === "0" ? "0" : "45.00",
    position_value: value === "0" ? "0" : "25.00",
    unrealized_pnl: "0",
    realized_pnl: "5.00",
    liquidation_price: value === "0" ? "0" : "30.00",
    margin_mode: 0,
    allocated_margin: "0",
  };
}

function positionFrame(value = "0"): LighterAccountAllPositionsStreamMessage {
  return {
    type: "update/account_all_positions",
    channel: "account_all_positions:42",
    positions: { "0": position(value) },
    shares: [],
  };
}

function tradeFrame(): LighterAccountAllTradesStreamMessage {
  return {
    type: "update/account_all_trades",
    channel: "account_all_trades:42",
    trades: {
      "0": [{
        trade_id: 1001,
        trade_id_str: "1001",
        tx_hash: "0xtrade",
        type: "trade",
        market_id: 0,
        size: "0.25",
        price: "50.00",
        usd_amount: "12.50",
        ask_id: Number.MAX_SAFE_INTEGER,
        ask_id_str: ORDER_ID,
        bid_id: 988,
        bid_id_str: "988",
        ask_client_id: 123,
        ask_client_id_str: "123",
        bid_client_id: 456,
        bid_client_id_str: "456",
        ask_account_id: 42,
        bid_account_id: 43,
        is_maker_ask: true,
        block_height: 99,
        timestamp: 1_800_000_000_000,
      }],
    },
  };
}

function deps(rows: readonly LighterOrderLifecycleIntentRow[]) {
  const markStreamEvidence = vi.fn(async (input: {
    state: LighterOrderLifecycleIntentRow["executionState"];
    evidence: Record<string, unknown>;
  }) => lifecycleIntent({ executionState: input.state, providerOutcomeJson: input.evidence }));
  const value = {
    client: { getNextNonce: vi.fn(async () => ({ code: 200, nonce: 10 })) },
    orderIntents: {
      listStreamWatchable: vi.fn<
        LighterAccountStreamReconciliationDeps["orderIntents"]["listStreamWatchable"]
      >(async () => []),
      markStreamOutcome: vi.fn(async () => null),
      markEvidenceConflict: vi.fn(async () => null),
    },
    lifecycleIntents: {
      listStreamWatchable: vi.fn(async () => [...rows]),
      markStreamEvidence,
    },
    nonceState: {
      find: vi.fn(async () => null),
      recordExecutionObserved: vi.fn(async () => null),
    },
  };
  return value as typeof value & LighterAccountStreamReconciliationDeps;
}

describe("Lighter account stream lifecycle reconciliation", () => {
  it("advances an exact create-order trade without matching numeric IDs", async () => {
    const d = deps([]);
    const create = {
      intentId: "lighter-exec-one",
      environment: "rhc",
      accountIndex: 42,
      apiKeyIndex: 7,
      marketIndex: 0,
      side: "sell",
      clientOrderIndex: "123",
      submittedTxHash: "different-hash",
      providerOutcomeSource: null,
      providerOutcomeJson: null,
    } as unknown as LighterOrderExecutionIntentRow;
    d.orderIntents.listStreamWatchable.mockResolvedValueOnce([create]);

    const report = await reconcileLighterAccountStreamMessage("rhc", 42, tradeFrame(), d);

    expect(report.createTradeMatches).toBe(1);
    expect(d.orderIntents.markStreamOutcome).toHaveBeenCalledWith(expect.objectContaining({
      intentId: "lighter-exec-one",
      state: "partially_filled",
      source: "account_trade",
      providerOrderId: ORDER_ID,
      providerOutcomeJson: expect.objectContaining({
        tradeId: "1001",
        clientOrderIndex: "123",
      }),
    }));
  });

  it("completes an exact cancel-one only from terminal target evidence", async () => {
    const d = deps([lifecycleIntent()]);
    const report = await reconcileLighterAccountStreamMessage(
      "rhc",
      42,
      orderFrame([order()]),
      d,
    );

    expect(report).toMatchObject({ lifecycleMatched: 1, lifecycleAdvanced: 1 });
    expect(d.lifecycleIntents.markStreamEvidence).toHaveBeenCalledWith(expect.objectContaining({
      state: "completed",
      evidence: expect.objectContaining({
        actionType: "cancel_one",
        disposition: "canceled",
        terminalOrder: expect.objectContaining({ orderId: ORDER_ID }),
      }),
    }));
  });

  it("completes modify only when exact scaled amount and price match", async () => {
    const row = lifecycleIntent({
      actionType: "modify",
      requestedBaseAmountInteger: "10000",
      requestedPriceInteger: "5050",
      providerSnapshotJson: { marketSizeDecimals: 4, marketPriceDecimals: 2 },
    });
    const d = deps([row]);
    await reconcileLighterAccountStreamMessage(
      "rhc",
      42,
      orderFrame([order({ status: "open", initial_base_amount: "1.0000", price: "50.50" })]),
      d,
    );

    expect(d.lifecycleIntents.markStreamEvidence).toHaveBeenCalledWith(expect.objectContaining({
      state: "completed",
      evidence: expect.objectContaining({ disposition: "modified" }),
    }));
  });

  it("accumulates exact cancel-all terminals across frames", async () => {
    const targetTwo = "1152921504606846974";
    const row = lifecycleIntent({
      actionType: "cancel_all",
      marketIndex: null,
      providerOrderId: null,
      providerSnapshotJson: {
        orders: [
          { orderId: ORDER_ID, marketIndex: 0 },
          { orderId: targetTwo, marketIndex: 0 },
        ],
      },
      providerOutcomeJson: {
        kind: "lighter_lifecycle_stream_evidence",
        actionType: "cancel_all",
        terminalOrders: [{ orderId: ORDER_ID, marketIndex: 0, status: "canceled" }],
      },
    });
    const d = deps([row]);
    await reconcileLighterAccountStreamMessage(
      "rhc",
      42,
      orderFrame([order({ order_id: targetTwo, status: "filled" })]),
      d,
    );

    expect(d.lifecycleIntents.markStreamEvidence).toHaveBeenCalledWith(expect.objectContaining({
      state: "completed",
      evidence: expect.objectContaining({ targetCount: 2 }),
    }));
  });

  it("requires correlated terminal order and resulting position evidence for close completion", async () => {
    const matchHash = "c".repeat(64);
    const clientOrderId = deriveVexAssignedClientOrderIndex(matchHash);
    const close = lifecycleIntent({
      actionType: "close_position",
      matchHash,
      providerOrderId: null,
      requestedBaseAmountInteger: "10000",
      requestedPriceInteger: "4950",
      requestedSide: "sell",
      reduceOnly: true,
      providerSnapshotJson: { position: { sign: 1, position: "1.0000" }, marketSizeDecimals: 4 },
    });
    const first = deps([close]);
    await reconcileLighterAccountStreamMessage("rhc", 42, orderFrame([order({
      client_order_id: clientOrderId,
      status: "filled",
    })]), first);
    const pendingCall = first.lifecycleIntents.markStreamEvidence.mock.calls[0]![0];
    expect(pendingCall.state).toBe("sequencer_pending");

    const stale = deps([lifecycleIntent({ ...close, providerOutcomeJson: pendingCall.evidence })]);
    await reconcileLighterAccountStreamMessage("rhc", 42, positionFrame("1.0000"), stale);
    expect(stale.lifecycleIntents.markStreamEvidence).toHaveBeenCalledWith(expect.objectContaining({ state: "sequencer_pending" }));

    const second = deps([lifecycleIntent({
      ...close,
      providerOutcomeJson: pendingCall.evidence,
    })]);
    await reconcileLighterAccountStreamMessage("rhc", 42, positionFrame("0"), second);

    expect(second.lifecycleIntents.markStreamEvidence).toHaveBeenCalledWith(expect.objectContaining({
      state: "completed",
      evidence: expect.objectContaining({
        disposition: "closed",
        closeOrder: expect.objectContaining({ clientOrderId }),
        resultingPosition: expect.objectContaining({ position: "0" }),
      }),
    }));
  });
});
