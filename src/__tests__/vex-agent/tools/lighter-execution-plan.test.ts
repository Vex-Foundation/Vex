import { describe, expect, it } from "vitest";

import {
  buildLighterOrderReadyForSignerPlan,
  requireLighterLiveTradingEnabled,
} from "@vex-agent/tools/protocols/lighter/execution-plan.js";
import type { LighterOrderExecutionIntentRow } from "@vex-agent/db/repos/lighter-order-execution-intents.js";

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
    credentialRefJson: {
      kind: "encrypted_vault_reference",
      environment: "rhc",
      accountIndex: 42,
      apiKeyIndex: 7,
      vaultCredentialId: "lighter/rhc/account-42/api-key-7",
    },
    approvalStatus: "approved",
    executionState: "approval_pending",
    decisionReason: "user approved exact Lighter order create intent",
    decidedAt: "2026-08-12T00:01:00.000Z",
    nonceReservationId: null,
    nonceValue: null,
    createdAt: "2026-08-12T00:00:01.000Z",
    updatedAt: "2026-08-12T00:00:02.000Z",
    expiresAt: "2030-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("Lighter order execution plan", () => {
  it("builds the signer-bound plan only from an approved durable intent", () => {
    const plan = buildLighterOrderReadyForSignerPlan(intent(), Date.parse("2026-08-12T00:02:00.000Z"));

    expect(plan).toMatchObject({
      intentId: "lighter-exec-1",
      previewId: "lighter-preview-1",
      matchHash: "a".repeat(64),
      environment: "rhc",
      accountIndex: 42,
      apiKeyIndex: 7,
      marketIndex: 0,
      side: "buy",
      baseAmountInteger: "10000",
      priceInteger: "300000",
      nonceScope: {
        environment: "rhc",
        accountIndex: 42,
        apiKeyIndex: 7,
      },
    });
  });

  it("refuses unapproved, expired, replayed, or mismatched intents before any signer path", () => {
    expect(() => buildLighterOrderReadyForSignerPlan(intent({ approvalStatus: "approval_pending" })))
      .toThrow("is not approved");
    expect(() =>
      buildLighterOrderReadyForSignerPlan(
        intent({ expiresAt: "2026-08-12T00:00:00.000Z" }),
        Date.parse("2026-08-12T00:01:00.000Z"),
      )
    ).toThrow("expired before signer preparation");
    expect(() =>
      buildLighterOrderReadyForSignerPlan(intent({
        nonceReservationId: "nonce-reservation-1",
        nonceValue: "12",
      }))
    ).toThrow("already has a nonce reservation");
    expect(() =>
      buildLighterOrderReadyForSignerPlan(intent({
        credentialRefJson: {
          kind: "encrypted_vault_reference",
          environment: "core",
          accountIndex: 42,
          apiKeyIndex: 7,
          vaultCredentialId: "lighter/core/account-42/api-key-7",
        },
      }))
    ).toThrow("credential reference does not match");
  });

  it("keeps live trading explicitly disabled until the submit milestone is approved", () => {
    expect(() => requireLighterLiveTradingEnabled()).toThrow("live trading is disabled");
  });
});
