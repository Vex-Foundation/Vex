import { describe, expect, it, vi } from "vitest";

import {
  LIGHTER_ORDER_REPAIR_EXPIRY_GRACE_MS,
  repairLighterOrderIntent,
  repairUnresolvedLighterOrders,
  type LighterOrderRepairDeps,
} from "@vex-agent/tools/protocols/lighter/order-repair.js";
import type { LighterOrderExecutionIntentRow } from "@vex-agent/db/repos/lighter-order-execution-intents.js";

const NOW = Date.parse("2026-08-14T12:00:00.000Z");
const ORDER_EXPIRY_MS = NOW + 30 * 60 * 1000;
const INTENT_ID = "lighter-exec-00000000-0000-4000-8000-000000000001";
const RESERVATION_ID = `lighter-order:${INTENT_ID}`;

function intentRow(
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
    orderExpiryMs: ORDER_EXPIRY_MS,
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
    executionState: "submitted",
    decisionReason: null,
    decidedAt: null,
    nonceReservationId: RESERVATION_ID,
    nonceValue: "1200",
    clientOrderIndex: "123456",
    signerTxHash: "0xsigner",
    submittedTxHash: "0xsubmitted",
    submitCode: null,
    submitMessage: null,
    predictedExecutionTimeMs: null,
    volumeQuotaRemaining: null,
    ambiguousReason: null,
    signedAt: "2026-08-14T11:00:00.000Z",
    submittedAt: "2026-08-14T11:00:01.000Z",
    apiAcceptedAt: null,
    ambiguousAt: null,
    providerOrderId: null,
    providerOrderStatus: null,
    providerOutcomeSource: null,
    providerOutcomeJson: null,
    providerOutcomeCheckedAt: null,
    preSubmitRevalidationJson: null,
    preSubmitRevalidatedAt: null,
    createdAt: "2026-08-14T10:59:00.000Z",
    updatedAt: "2026-08-14T11:00:01.000Z",
    expiresAt: "2026-08-14T11:02:00.000Z",
    ...overrides,
  } as LighterOrderExecutionIntentRow;
}

function nonceRow(overrides: Record<string, unknown> = {}) {
  return {
    environment: "rhc",
    accountIndex: 42,
    apiKeyIndex: 7,
    providerNonce: "1200",
    publicKey: "ab".repeat(20),
    providerTransactionTime: null,
    status: "reserved",
    reservedNonce: "1200",
    reservationId: RESERVATION_ID,
    source: "live_lighter_public_api",
    observedAt: "2026-08-14T11:00:00.000Z",
    updatedAt: "2026-08-14T11:00:00.000Z",
    ...overrides,
  };
}

function makeDeps(overrides: {
  readonly nextNonce?: number | Error;
  readonly nonceRow?: ReturnType<typeof nonceRow> | null;
  readonly hasReadOnlyCredential?: boolean;
  readonly activeOrders?: unknown[];
  readonly inactiveOrders?: unknown[];
  readonly trades?: unknown[];
  readonly now?: number;
} = {}) {
  const deps = {
    client: {
      getNextNonce: vi.fn(async () => {
        if (overrides.nextNonce instanceof Error) throw overrides.nextNonce;
        return { code: 200, nonce: overrides.nextNonce ?? 1200 };
      }),
      getAccountActiveOrders: vi.fn(async () => ({ code: 200, orders: overrides.activeOrders ?? [] })),
      getAccountInactiveOrders: vi.fn(async () => ({ code: 200, orders: overrides.inactiveOrders ?? [] })),
      getAccountTrades: vi.fn(async () => ({ code: 200, trades: overrides.trades ?? [] })),
    },
    intents: {
      listUnresolved: vi.fn(async () => []),
      findByIntentIdAnySession: vi.fn(async () => null),
      markRepairResolved: vi.fn(async (input: { state: string }) =>
        intentRow({ executionState: input.state as LighterOrderExecutionIntentRow["executionState"] })),
    },
    nonceState: {
      find: vi.fn(async () => (overrides.nonceRow === undefined ? nonceRow() : overrides.nonceRow)),
      releaseReservation: vi.fn(async () => nonceRow({ status: "observed", reservedNonce: null, reservationId: null })),
      recordExecutionObserved: vi.fn(async () => nonceRow({ status: "observed" })),
    },
    hasReadOnlyCredential: vi.fn(() => overrides.hasReadOnlyCredential ?? false),
    now: () => overrides.now ?? NOW,
  };
  return deps as typeof deps & LighterOrderRepairDeps;
}

describe("Lighter order repair", () => {
  it("classifies from provider evidence and refreshes the nonce when a read-only token exists", async () => {
    const deps = makeDeps({
      hasReadOnlyCredential: true,
      nextNonce: 1201,
      inactiveOrders: [{
        order_index: null,
        order_id: "987",
        client_order_id: "123456",
        market_index: 0,
        owner_account_index: 42,
        status: "filled",
        filled_base_amount: "1.0",
        remaining_base_amount: "0",
      }],
    });

    const report = await repairLighterOrderIntent(intentRow(), deps);

    expect(report.resolution).toBe("provider_evidence");
    expect(report.evidenceSource).toBe("inactive_order");
    expect(report.stateAfter).toBe("filled");
    expect(deps.intents.markRepairResolved).toHaveBeenCalledWith(expect.objectContaining({
      intentId: INTENT_ID,
      state: "filled",
      source: "inactive_order",
      providerOrderId: "987",
    }));
    expect(deps.nonceState.recordExecutionObserved).toHaveBeenCalledWith(expect.objectContaining({
      nonce: 1201,
    }));
  });

  it("classifies from provider evidence via a trading-key auth token when no read-only token exists", async () => {
    const privilegedAuth = { token: "derived-account-auth-token", accountIndex: 42 };
    const resolvePrivilegedAccountAuth = vi.fn(async () => privilegedAuth);
    const deps = {
      ...makeDeps({
        hasReadOnlyCredential: false,
        nextNonce: 1201,
        inactiveOrders: [{
          order_index: null,
          order_id: "987",
          client_order_id: "123456",
          market_index: 0,
          owner_account_index: 42,
          status: "filled",
          filled_base_amount: "1.0",
          remaining_base_amount: "0",
        }],
      }),
      resolvePrivilegedAccountAuth,
    };

    const report = await repairLighterOrderIntent(intentRow(), deps);

    // Derived the token from the intent's own credential reference...
    expect(resolvePrivilegedAccountAuth).toHaveBeenCalledWith(intentRow().credentialRefJson);
    // ...and used it as the privileged auth on the account reads.
    expect(deps.client.getAccountInactiveOrders).toHaveBeenCalledWith(
      "rhc",
      expect.objectContaining({ accountIndex: 42 }),
      privilegedAuth,
    );
    expect(report.resolution).toBe("provider_evidence");
    expect(report.stateAfter).toBe("filled");
    expect(deps.intents.markRepairResolved).toHaveBeenCalledWith(expect.objectContaining({
      intentId: INTENT_ID,
      state: "filled",
      source: "inactive_order",
    }));
  });

  it("skips account reads and defers to nonce facts when no read-only token and no trading-key auth are available", async () => {
    const deps = {
      ...makeDeps({
        hasReadOnlyCredential: false,
        nextNonce: 1201,
        inactiveOrders: [{
          order_index: null,
          order_id: "987",
          client_order_id: "123456",
          market_index: 0,
          owner_account_index: 42,
          status: "filled",
          filled_base_amount: "1.0",
          remaining_base_amount: "0",
        }],
      }),
      resolvePrivilegedAccountAuth: vi.fn(async () => null),
    };

    const report = await repairLighterOrderIntent(intentRow(), deps);

    // No auth available: never touch authenticated account endpoints.
    expect(deps.client.getAccountInactiveOrders).not.toHaveBeenCalled();
    expect(deps.intents.markRepairResolved).not.toHaveBeenCalled();
    // Falls back to nonce facts: reserved 1200 vs live 1201 => consumed.
    expect(report.resolution).toBe("nonce_reset_consumed");
  });

  it("resets the nonce without guessing the order outcome when the reserved nonce was consumed", async () => {
    const deps = makeDeps({ nextNonce: 1250 });

    const report = await repairLighterOrderIntent(intentRow(), deps);

    expect(report.resolution).toBe("nonce_reset_consumed");
    expect(report.nonceBlockedAfter).toBe(false);
    expect(report.stateAfter).toBe("submitted");
    expect(deps.intents.markRepairResolved).not.toHaveBeenCalled();
    expect(deps.nonceState.releaseReservation).not.toHaveBeenCalled();
  });

  it("releases the reservation and rejects the intent when the signed order never left Vex", async () => {
    const deps = makeDeps({ nextNonce: 1200 });
    const intent = intentRow({
      executionState: "ambiguous",
      ambiguousReason: "signing_failed_after_nonce_reservation",
      submittedAt: null,
      signedAt: null,
      signerTxHash: null,
      submittedTxHash: null,
      clientOrderIndex: null,
      ambiguousAt: "2026-08-14T11:00:02.000Z",
    });

    const report = await repairLighterOrderIntent(intent, deps);

    expect(report.resolution).toBe("nonce_released_never_submitted");
    expect(report.stateAfter).toBe("rejected");
    expect(report.nonceBlockedAfter).toBe(false);
    expect(deps.nonceState.releaseReservation).toHaveBeenCalledWith(expect.objectContaining({
      reservationId: RESERVATION_ID,
      providerNonce: 1200,
    }));
    expect(deps.intents.markRepairResolved).toHaveBeenCalledWith(expect.objectContaining({
      state: "rejected",
      source: "not_found",
    }));
  });

  it("waits while a possibly-sent order is not yet past expiry, holding the reservation", async () => {
    const deps = makeDeps({ nextNonce: 1200, now: NOW });

    const report = await repairLighterOrderIntent(intentRow(), deps);

    expect(report.resolution).toBe("awaiting_provider");
    expect(report.nonceBlockedAfter).toBe(true);
    expect(report.guidance).toContain("Do not resubmit");
    expect(deps.nonceState.releaseReservation).not.toHaveBeenCalled();
    expect(deps.intents.markRepairResolved).not.toHaveBeenCalled();
  });

  it("releases the reservation once the order expiry passed with the nonce unconsumed", async () => {
    const deps = makeDeps({
      nextNonce: 1200,
      now: ORDER_EXPIRY_MS + LIGHTER_ORDER_REPAIR_EXPIRY_GRACE_MS + 1,
    });

    const report = await repairLighterOrderIntent(intentRow(), deps);

    expect(report.resolution).toBe("nonce_released_expired_unconsumed");
    expect(report.stateAfter).toBe("rejected");
    expect(report.nonceBlockedAfter).toBe(false);
    expect(deps.nonceState.releaseReservation).toHaveBeenCalled();
  });

  it("never frees a reservation held by a different intent", async () => {
    const deps = makeDeps({
      nextNonce: 1200,
      nonceRow: nonceRow({ reservationId: "lighter-order:someone-else" }),
    });

    const report = await repairLighterOrderIntent(intentRow(), deps);

    expect(report.resolution).toBe("awaiting_provider");
    expect(deps.nonceState.releaseReservation).not.toHaveBeenCalled();
    expect(deps.intents.markRepairResolved).not.toHaveBeenCalled();
  });

  it("changes nothing and reports degraded when the live nextNonce is unreachable", async () => {
    const deps = makeDeps({ nextNonce: new Error("offline") });

    const report = await repairLighterOrderIntent(intentRow(), deps);

    expect(report.resolution).toBe("degraded");
    expect(deps.nonceState.releaseReservation).not.toHaveBeenCalled();
    expect(deps.intents.markRepairResolved).not.toHaveBeenCalled();
  });

  it("reports an anomalous provider nonce behind the reservation without touching state", async () => {
    const deps = makeDeps({ nextNonce: 1100 });

    const report = await repairLighterOrderIntent(intentRow(), deps);

    expect(report.resolution).toBe("degraded");
    expect(report.guidance).toContain("behind the locally reserved nonce");
    expect(deps.nonceState.releaseReservation).not.toHaveBeenCalled();
  });

  it("skips terminal intents untouched", async () => {
    const deps = makeDeps();

    const report = await repairLighterOrderIntent(
      intentRow({ executionState: "filled" }),
      deps,
    );

    expect(report.resolution).toBe("already_terminal");
    expect(deps.client.getNextNonce).not.toHaveBeenCalled();
  });

  it("sweeps every unresolved intent through the same repair path", async () => {
    const deps = makeDeps({ nextNonce: 1250 });
    deps.intents.listUnresolved.mockResolvedValueOnce([
      intentRow(),
      intentRow({ intentId: "lighter-exec-00000000-0000-4000-8000-000000000002", executionState: "sequencer_pending" }),
    ]);

    const reports = await repairUnresolvedLighterOrders({ environment: "rhc" }, deps);

    expect(deps.intents.listUnresolved).toHaveBeenCalledWith("rhc", 10);
    expect(reports).toHaveLength(2);
    expect(reports[0]!.resolution).toBe("nonce_reset_consumed");
  });
});
