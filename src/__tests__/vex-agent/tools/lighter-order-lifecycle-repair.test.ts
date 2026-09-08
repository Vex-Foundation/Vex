import { describe, expect, it, vi } from "vitest";

import { deriveVexAssignedClientOrderIndex } from "@tools/lighter/signer-order.js";
import type { LighterAccountOrder } from "@tools/lighter/types.js";
import type { LighterOrderLifecycleIntentRow } from "@vex-agent/db/repos/lighter-order-lifecycle-intents.js";
import {
  LIGHTER_LIFECYCLE_REPAIR_EXPIRY_GRACE_MS,
  repairLighterOrderLifecycleIntent,
  type LighterOrderLifecycleRepairDeps,
} from "@vex-agent/tools/protocols/lighter/order-lifecycle-repair.js";

const NOW = Date.parse("2026-08-19T22:00:00.000Z");

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
    providerOrderId: "1152921504606846975",
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
    executionState: "ambiguous",
    decisionReason: "approved",
    decidedAt: "2026-08-19T21:55:00.000Z",
    preSubmitRevalidationJson: null,
    preSubmitRevalidatedAt: null,
    nonceReservationId: "lighter-lifecycle:one",
    nonceValue: "9",
    signerExpiryMs: NOW - LIGHTER_LIFECYCLE_REPAIR_EXPIRY_GRACE_MS - 1,
    signerTxHash: "signer-hash",
    submittedTxHash: "submitted-hash",
    submitCode: 200,
    submitMessage: "accepted",
    predictedExecutionTimeMs: 10,
    volumeQuotaRemaining: null,
    providerOutcomeJson: null,
    providerOutcomeCheckedAt: null,
    ambiguousReason: "send_tx_transport_ambiguous",
    createdAt: "2026-08-19T21:54:00.000Z",
    updatedAt: "2026-08-19T21:56:00.000Z",
    expiresAt: "2026-08-19T22:05:00.000Z",
    ...overrides,
  };
}

function nonce(status: "reserved" | "observed" = "reserved") {
  return {
    environment: "rhc" as const,
    accountIndex: 42,
    apiKeyIndex: 7,
    providerNonce: "9",
    publicKey: "ab".repeat(20),
    providerTransactionTime: null,
    status,
    reservedNonce: status === "reserved" ? "9" : null,
    reservationId: status === "reserved" ? "lighter-lifecycle:one" : null,
    source: "live_lighter_public_api" as const,
    observedAt: "2026-08-19T21:55:00.000Z",
    updatedAt: "2026-08-19T21:55:00.000Z",
  };
}

function deps(initial: LighterOrderLifecycleIntentRow, provider: {
  active?: readonly LighterAccountOrder[];
  inactive?: readonly LighterAccountOrder[];
  positions?: readonly Record<string, unknown>[];
  nextNonce?: number;
  readsFail?: boolean;
} = {}) {
  let current = initial;
  const markStreamEvidence = vi.fn(async (input: {
    state: LighterOrderLifecycleIntentRow["executionState"];
    evidence: Record<string, unknown>;
  }) => {
    current = intent({ ...current, executionState: input.state, providerOutcomeJson: input.evidence });
    return current;
  });
  const failed = async () => { throw new Error("unavailable"); };
  const client = {
    getNextNonce: vi.fn(async () => ({ code: 200, nonce: provider.nextNonce ?? 9 })),
    getAccountActiveOrders: vi.fn(provider.readsFail ? failed : async () => ({ code: 200, orders: provider.active ?? [] })),
    getAccountInactiveOrders: vi.fn(provider.readsFail ? failed : async () => ({ code: 200, orders: provider.inactive ?? [] })),
    getAccountTrades: vi.fn(provider.readsFail ? failed : async () => ({ code: 200, trades: [] })),
    getAccount: vi.fn(provider.readsFail ? failed : async () => ({
      code: 200,
      accounts: [{ index: 42, positions: provider.positions ?? [] }],
    })),
  };
  const value = {
    client,
    lifecycleIntents: {
      findByIntentIdAnySession: vi.fn(async () => current),
      listStatusCandidates: vi.fn(async () => [current]),
      listStreamWatchable: vi.fn(async () => [current]),
      markStreamEvidence,
    },
    orderIntents: {
      listStreamWatchable: vi.fn(async () => []),
      markStreamOutcome: vi.fn(async () => null),
      markEvidenceConflict: vi.fn(async () => null),
    },
    nonceState: {
      find: vi.fn(async () => nonce()),
      recordExecutionObserved: vi.fn(async () => nonce("observed")),
      releaseReservation: vi.fn(async () => nonce("observed")),
    },
    resolveAuth: vi.fn(async () => ({ token: "read-only", accountIndex: 42 })),
    now: () => NOW,
  };
  return value as typeof value & LighterOrderLifecycleRepairDeps;
}

describe("Lighter order lifecycle repair", () => {
  it("reports an expired approved pre-submit close instead of hiding it from status", async () => {
    const row = intent({
      actionType: "close_position",
      providerOrderId: null,
      requestedBaseAmountInteger: "10000",
      requestedPriceInteger: "4950",
      requestedSide: "sell",
      reduceOnly: true,
      approvalStatus: "approved",
      executionState: "approved",
      nonceReservationId: null,
      nonceValue: null,
      signerExpiryMs: null,
      signerTxHash: null,
      submittedTxHash: null,
      submitCode: null,
      submitMessage: null,
      ambiguousReason: null,
      expiresAt: "2026-08-19T21:59:00.000Z",
    });
    const d = deps(row);

    const report = await repairLighterOrderLifecycleIntent(row, d);

    expect(report).toMatchObject({
      resolution: "stale_pre_submit",
      stateBefore: "approved",
      stateAfter: "approved",
      nonceBlockedBefore: false,
      nonceBlockedAfter: false,
    });
    expect(report.guidance).toContain("Prepare a fresh action");
    expect(d.client.getNextNonce).not.toHaveBeenCalled();
    expect(d.resolveAuth).not.toHaveBeenCalled();
  });

  it("resolves a reduce-only close from exact terminal order and full flat account snapshot", async () => {
    const matchHash = "c".repeat(64);
    const clientOrderId = deriveVexAssignedClientOrderIndex(matchHash);
    const closeOrder: LighterAccountOrder = {
      order_index: Number.MAX_SAFE_INTEGER,
      client_order_index: Number(clientOrderId),
      order_id: "1152921504606846975",
      client_order_id: clientOrderId,
      market_index: 0,
      owner_account_index: 42,
      initial_base_amount: "1.0000",
      remaining_base_amount: "0",
      filled_base_amount: "1.0000",
      filled_quote_amount: "50.000000",
      price: "49.50",
      status: "filled",
    };
    const row = intent({
      actionType: "close_position",
      matchHash,
      providerOrderId: null,
      requestedBaseAmountInteger: "10000",
      requestedPriceInteger: "4950",
      requestedSide: "sell",
      reduceOnly: true,
      providerSnapshotJson: { position: { sign: 1, position: "1.0000" }, marketSizeDecimals: 4 },
    });
    const d = deps(row, { inactive: [closeOrder], positions: [] });

    const report = await repairLighterOrderLifecycleIntent(row, d);

    expect(report).toMatchObject({
      resolution: "provider_evidence",
      stateAfter: "completed",
      executedAmount: "1.0000",
      remainingAmount: "0",
      averageFillPrice: "50",
      resultingPosition: null,
      providerStatus: "filled",
      nonceBlockedAfter: false,
    });
    expect(d.lifecycleIntents.markStreamEvidence).toHaveBeenLastCalledWith(expect.objectContaining({
      state: "completed",
      evidence: expect.objectContaining({
        disposition: "closed",
        positionEvidenceSource: "account_rest_full_snapshot_absence",
      }),
    }));
  });

  it("releases a signed lifecycle transaction that never reached submission", async () => {
    const row = intent({
      executionState: "signed",
      ambiguousReason: null,
      submittedTxHash: null,
      signerExpiryMs: NOW + 60_000,
    });
    const d = deps(row, { readsFail: true });

    const report = await repairLighterOrderLifecycleIntent(row, d);

    expect(report.resolution).toBe("nonce_released_never_submitted");
    expect(report.stateAfter).toBe("rejected");
    expect(report.nonceBlockedAfter).toBe(false);
    expect(d.nonceState.releaseReservation).toHaveBeenCalledOnce();
  });

  it("releases an expired transaction only when the live nonce stayed unconsumed", async () => {
    const row = intent();
    const d = deps(row, { readsFail: true, nextNonce: 9 });

    const report = await repairLighterOrderLifecycleIntent(row, d);

    expect(report.resolution).toBe("nonce_released_expired_unconsumed");
    expect(d.nonceState.releaseReservation).toHaveBeenCalledWith(expect.objectContaining({ providerNonce: 9 }));
  });

  it("unblocks a consumed nonce without claiming the lifecycle action completed", async () => {
    const row = intent({ signerExpiryMs: NOW + 60_000 });
    const d = deps(row, { readsFail: true, nextNonce: 10 });

    const report = await repairLighterOrderLifecycleIntent(row, d);

    expect(report).toMatchObject({
      resolution: "nonce_consumed_outcome_pending",
      stateAfter: "ambiguous",
      nonceBlockedAfter: false,
    });
    expect(d.nonceState.recordExecutionObserved).toHaveBeenCalledWith(expect.objectContaining({ nonce: 10 }));
    expect(d.lifecycleIntents.markStreamEvidence).not.toHaveBeenCalled();
    expect(d.nonceState.releaseReservation).not.toHaveBeenCalled();
  });
});
