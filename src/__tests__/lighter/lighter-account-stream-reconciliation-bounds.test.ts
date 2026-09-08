import { describe, expect, it, vi } from "vitest";

import { deriveVexAssignedClientOrderIndex } from "@tools/lighter/signer-order.js";
import type {
  LighterAccountAllOrdersStreamMessage,
  LighterAccountAllTradesStreamMessage,
  LighterAccountOrder,
} from "@tools/lighter/types.js";
import type { LighterOrderLifecycleIntentRow } from "@vex-agent/db/repos/lighter-order-lifecycle-intents.js";
import {
  LIGHTER_LIFECYCLE_EVIDENCE_MAX_ROWS,
  reconcileLighterAccountStreamMessage,
  type LighterAccountStreamReconciliationDeps,
} from "@vex-agent/tools/protocols/lighter/account-stream-reconciliation.js";

const MATCH_HASH = "b".repeat(64);
const TARGET_COUNT = LIGHTER_LIFECYCLE_EVIDENCE_MAX_ROWS + 50;

function lifecycleIntent(
  overrides: Partial<LighterOrderLifecycleIntentRow> = {},
): LighterOrderLifecycleIntentRow {
  return {
    intentId: `lighter-lifecycle-${"a".repeat(32)}`,
    sessionId: "session-1",
    protocolExecutionId: null,
    approvalId: "approval-1",
    matchHash: MATCH_HASH,
    environment: "rhc",
    accountIndex: 42,
    apiKeyIndex: 7,
    actionType: "cancel_all",
    marketIndex: 0,
    providerOrderId: null,
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
    decidedAt: "2026-09-07T20:00:00.000Z",
    preSubmitRevalidationJson: null,
    preSubmitRevalidatedAt: null,
    nonceReservationId: "lighter-lifecycle:all",
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
    createdAt: "2026-09-07T19:59:00.000Z",
    updatedAt: "2026-09-07T20:00:00.000Z",
    expiresAt: "2026-09-07T20:05:00.000Z",
    ...overrides,
  } as LighterOrderLifecycleIntentRow;
}

function order(orderId: string): LighterAccountOrder {
  return {
    order_index: Number.MAX_SAFE_INTEGER,
    client_order_index: 123,
    order_id: orderId,
    client_order_id: "123",
    market_index: 0,
    owner_account_index: 42,
    initial_base_amount: "1.0000",
    remaining_base_amount: "0",
    filled_base_amount: "0",
    filled_quote_amount: "0",
    price: "50.00",
    side: "buy",
    status: "canceled",
  } as LighterAccountOrder;
}

function cancelAllTargets(count: number) {
  return Array.from({ length: count }, (_value, index) => ({
    orderId: String(1_000_000 + index),
    marketIndex: 0,
  }));
}

function orderFrame(orders: readonly LighterAccountOrder[]): LighterAccountAllOrdersStreamMessage {
  return {
    type: "update/account_all_orders",
    channel: "account_all_orders:42",
    orders: { "0": [...orders] },
  };
}

function closeTradeFrame(tradeId: string): LighterAccountAllTradesStreamMessage {
  return {
    type: "update/account_all_trades",
    channel: "account_all_trades:42",
    trades: {
      "0": [{
        trade_id: Number(tradeId),
        trade_id_str: tradeId,
        tx_hash: "0xtrade",
        type: "trade",
        market_id: 0,
        size: "0.25",
        price: "50.00",
        usd_amount: "12.50",
        ask_id: 1,
        ask_id_str: "1",
        bid_id: 2,
        bid_id_str: "2",
        ask_client_id: 1,
        ask_client_id_str: "1",
        bid_client_id: 2,
        bid_client_id_str: deriveVexAssignedClientOrderIndex(MATCH_HASH),
        ask_account_id: 43,
        bid_account_id: 42,
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
      listStreamWatchable: vi.fn(async () => []),
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
  return value as typeof value & LighterAccountStreamReconciliationDeps & {
    lifecycleIntents: { markStreamEvidence: typeof markStreamEvidence };
  };
}

describe("Lighter lifecycle stream evidence bounds", () => {
  it("completes a cancel-all with more targets than the evidence bound and reports the bound", async () => {
    const targets = cancelAllTargets(TARGET_COUNT);
    const intent = lifecycleIntent({ providerSnapshotJson: { orders: targets } });
    const d = deps([intent]);

    const report = await reconcileLighterAccountStreamMessage(
      "rhc",
      42,
      orderFrame(targets.map((target) => order(target.orderId))),
      d,
    );

    expect(report).toMatchObject({ lifecycleMatched: 1, lifecycleAdvanced: 1 });
    const call = d.lifecycleIntents.markStreamEvidence.mock.calls[0]?.[0];
    // Every approved target is terminal, so the action IS complete even though
    // the retained rich rows stop at the declared bound.
    expect(call?.state).toBe("completed");
    const evidence = call?.evidence as Record<string, unknown>;
    expect(evidence.targetCount).toBe(TARGET_COUNT);
    expect(evidence.terminalOrdersTotal).toBe(TARGET_COUNT);
    expect(evidence.terminalOrdersRetained).toBe(LIGHTER_LIFECYCLE_EVIDENCE_MAX_ROWS);
    expect(evidence.terminalOrdersTruncated).toBe(true);
    expect((evidence.terminalOrders as unknown[]).length)
      .toBe(LIGHTER_LIFECYCLE_EVIDENCE_MAX_ROWS);
    // The identity set that carries the decision stays complete.
    expect((evidence.terminalOrderIds as string[]).length).toBe(TARGET_COUNT);
  });

  it("reports how many retained close-position fills the bound left out", async () => {
    const previousTrades = Array.from(
      { length: LIGHTER_LIFECYCLE_EVIDENCE_MAX_ROWS },
      (_value, index) => ({
        tradeId: String(500 + index),
        orderId: "2",
        size: "0.25",
        price: "50.00",
        txHash: "0xtrade",
      }),
    );
    const intent = lifecycleIntent({
      actionType: "close_position",
      requestedSide: "buy",
      providerSnapshotJson: { position: { position: "1", sign: 1 }, marketSizeDecimals: 4 },
      providerOutcomeJson: {
        kind: "lighter_lifecycle_stream_evidence",
        trades: previousTrades,
        tradesTotal: LIGHTER_LIFECYCLE_EVIDENCE_MAX_ROWS,
        tradesDropped: 0,
      },
    });
    const d = deps([intent]);

    await reconcileLighterAccountStreamMessage("rhc", 42, closeTradeFrame("9999"), d);

    const evidence = d.lifecycleIntents.markStreamEvidence.mock.calls[0]?.[0]
      .evidence as Record<string, unknown>;
    expect((evidence.trades as unknown[]).length).toBe(LIGHTER_LIFECYCLE_EVIDENCE_MAX_ROWS);
    expect(evidence.tradesRetained).toBe(LIGHTER_LIFECYCLE_EVIDENCE_MAX_ROWS);
    expect(evidence.tradesTotal).toBe(LIGHTER_LIFECYCLE_EVIDENCE_MAX_ROWS + 1);
    expect(evidence.tradesDropped).toBe(1);
    expect(evidence.tradesTruncated).toBe(true);
  });
});
