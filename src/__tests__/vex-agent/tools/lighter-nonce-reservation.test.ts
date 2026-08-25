import { describe, expect, it, vi } from "vitest";

import {
  reserveLighterOrderNonceForSigning,
  type ReserveLighterOrderNonceDeps,
} from "@vex-agent/tools/protocols/lighter/nonce-reservation.js";
import type { LighterNonceStateRow } from "@vex-agent/db/repos/lighter-nonce-state.js";
import type { LighterOrderExecutionIntentRow } from "@vex-agent/db/repos/lighter-order-execution-intents.js";
import type { LighterOrderReadyForSignerPlan } from "@vex-agent/tools/protocols/lighter/execution-plan.js";

const PLAN: LighterOrderReadyForSignerPlan = {
  intentId: "lighter-exec-1",
  sessionId: "session-1",
  previewId: "lighter-preview-1",
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
  orderExpiryMs: 1893456000000,
  clientOrderIndexPolicy: "vex_assigned_uint48",
  providerVersion: "lighter-preview-v1",
  credentialReference: {
    kind: "encrypted_vault_reference",
    environment: "rhc",
    accountIndex: 42,
    apiKeyIndex: 7,
    vaultCredentialId: "lighter/rhc/account-42/api-key-7",
  },
  nonceScope: {
    environment: "rhc",
    accountIndex: 42,
    apiKeyIndex: 7,
  },
};

function reservedNonce(overrides: Partial<LighterNonceStateRow> = {}): LighterNonceStateRow {
  return {
    environment: "rhc",
    accountIndex: 42,
    apiKeyIndex: 7,
    providerNonce: "1784732515923",
    publicKey: "public-key",
    providerTransactionTime: "1784732516903382",
    status: "reserved",
    reservedNonce: "1784732515923",
    reservationId: "lighter-order:lighter-exec-1",
    source: "live_lighter_public_api",
    observedAt: "2026-08-12T00:00:00.000Z",
    updatedAt: "2026-08-12T00:00:01.000Z",
    ...overrides,
  };
}

function intent(overrides: Partial<LighterOrderExecutionIntentRow> = {}): LighterOrderExecutionIntentRow {
  return {
    intentId: "lighter-exec-1",
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
    orderExpiryMs: 1893456000000,
    clientOrderIndexPolicy: "vex_assigned_uint48",
    providerVersion: "lighter-preview-v1",
    credentialRefJson: PLAN.credentialReference,
    approvalStatus: "approved",
    executionState: "approval_pending",
    decisionReason: "user approved exact Lighter order create intent",
    decidedAt: "2026-08-12T00:01:00.000Z",
    nonceReservationId: "lighter-order:lighter-exec-1",
    nonceValue: "1784732515923",
    clientOrderIndex: null,
    signerTxHash: null,
    submittedTxHash: null,
    submitCode: null,
    submitMessage: null,
    predictedExecutionTimeMs: null,
    volumeQuotaRemaining: null,
    ambiguousReason: null,
    signedAt: null,
    submittedAt: null,
    apiAcceptedAt: null,
    ambiguousAt: null,
    providerOrderId: null,
    providerOrderStatus: null,
    providerOutcomeSource: null,
    providerOutcomeJson: null,
    providerOutcomeCheckedAt: null,
    preSubmitRevalidationJson: null,
    preSubmitRevalidatedAt: null,
    createdAt: "2026-08-12T00:00:01.000Z",
    updatedAt: "2026-08-12T00:00:02.000Z",
    expiresAt: "2030-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function deps(overrides: Partial<ReserveLighterOrderNonceDeps> = {}): ReserveLighterOrderNonceDeps {
  const txClient = { tx: true };
  return {
    transaction: vi.fn(async (fn) => fn(txClient as never)),
    nonceState: {
      reserveObservedWith: vi.fn(async () => reservedNonce()),
    },
    intents: {
      attachNonceReservationWith: vi.fn(async () => intent()),
    },
    ...overrides,
  };
}

describe("Lighter order nonce reservation for signing", () => {
  it("reserves an observed nonce and attaches it to the exact approved intent in one transaction", async () => {
    const d = deps();

    const reservation = await reserveLighterOrderNonceForSigning(PLAN, d);

    expect(d.transaction).toHaveBeenCalledTimes(1);
    expect(d.nonceState.reserveObservedWith).toHaveBeenCalledWith(expect.anything(), {
      environment: "rhc",
      accountIndex: 42,
      apiKeyIndex: 7,
      reservationId: "lighter-order:lighter-exec-1",
    });
    expect(d.intents.attachNonceReservationWith).toHaveBeenCalledWith(expect.anything(), {
      intentId: "lighter-exec-1",
      sessionId: "session-1",
      environment: "rhc",
      accountIndex: 42,
      apiKeyIndex: 7,
      reservationId: "lighter-order:lighter-exec-1",
      nonceValue: "1784732515923",
    });
    expect(reservation).toEqual({
      kind: "lighter_order_nonce_reservation",
      intentId: "lighter-exec-1",
      sessionId: "session-1",
      reservationId: "lighter-order:lighter-exec-1",
      nonceValue: "1784732515923",
      environment: "rhc",
      accountIndex: 42,
      apiKeyIndex: 7,
    });
  });

  it("refuses to continue when no observed nonce can be reserved", async () => {
    const d = deps({
      nonceState: {
        reserveObservedWith: vi.fn(async () => null),
      },
    });

    await expect(reserveLighterOrderNonceForSigning(PLAN, d))
      .rejects.toThrow("No observed Lighter nonce is available");
    expect(d.intents.attachNonceReservationWith).not.toHaveBeenCalled();
  });

  it("refuses to attach a reserved nonce from the wrong scope", async () => {
    const d = deps({
      nonceState: {
        reserveObservedWith: vi.fn(async () => reservedNonce({ environment: "core" })),
      },
    });

    await expect(reserveLighterOrderNonceForSigning(PLAN, d))
      .rejects.toThrow("does not match the prepared order scope");
    expect(d.intents.attachNonceReservationWith).not.toHaveBeenCalled();
  });

  it("refuses to continue when the approved intent cannot accept the reservation", async () => {
    const d = deps({
      intents: {
        attachNonceReservationWith: vi.fn(async () => null),
      },
    });

    await expect(reserveLighterOrderNonceForSigning(PLAN, d))
      .rejects.toThrow("could not attach the nonce reservation");
  });
});
