import { describe, expect, it, vi } from "vitest";

import type { LighterKeyRegistrationReservationRow } from "@vex-agent/db/repos/lighter-key-registration-intents.js";
import type { LighterNonceStateRow } from "@vex-agent/db/repos/lighter-nonce-state.js";
import {
  resolveManagedLighterTradingReadiness,
  type LighterManagedTradingReadinessDeps,
} from "../managed-trading-readiness.js";

const PUBLIC_KEY = "ab".repeat(40);
const OTHER_PUBLIC_KEY = "cd".repeat(40);
const PRIVATE_KEY = "11".repeat(40);
const NOW = new Date("2026-08-18T10:00:00.000Z");

function activeIntent(
  overrides: Partial<LighterKeyRegistrationReservationRow> = {},
): LighterKeyRegistrationReservationRow {
  return {
    intentId: "lighter-keyreg-1",
    sessionId: "session-1",
    environment: "core",
    walletAddress: "0x1111111111111111111111111111111111111111",
    chainId: 1,
    accountIndex: 42,
    apiKeyIndex: 4,
    slotObservedAt: NOW,
    slotObservationHash: "a".repeat(64),
    approvalStatus: "approved",
    executionState: "active",
    vaultCredentialId: "lighter/core/account-42/api-key-4",
    publicKey: PUBLIC_KEY,
    publicKeyFingerprint: "b".repeat(64),
    keyGeneratedAt: NOW,
    registrationNonce: "0",
    registrationNonceObservedAt: NOW,
    registrationTxType: 8,
    registrationTxHash: "c".repeat(80),
    registrationTxExpiredAt: "0",
    registrationTxStagedAt: NOW,
    registrationSubmittedTxHash: "c".repeat(80),
    registrationSubmitCode: 200,
    registrationPredictedExecutionTimeMs: "1",
    registrationSubmitAcceptedAt: NOW,
    registrationAmbiguityReason: null,
    registrationKeyVerifiedAt: NOW,
    registrationClientCheckedAt: NOW,
    postRegistrationNonce: "1",
    registrationNonceSynchronizedAt: NOW,
    registrationActivatedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
    expiresAt: new Date("2026-08-18T11:00:00.000Z"),
    ...overrides,
  };
}

function observedNonce(overrides: Partial<LighterNonceStateRow> = {}): LighterNonceStateRow {
  return {
    environment: "core",
    accountIndex: 42,
    apiKeyIndex: 4,
    providerNonce: "1",
    publicKey: PUBLIC_KEY,
    providerTransactionTime: "1",
    status: "observed",
    reservedNonce: null,
    reservationId: null,
    source: "live_lighter_public_api",
    observedAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    ...overrides,
  };
}

function deps(
  overrides: Partial<LighterManagedTradingReadinessDeps> = {},
): LighterManagedTradingReadinessDeps {
  return {
    listManagedScopes: () => [{ environment: "core", accountIndex: 42, apiKeyIndex: 4 }],
    findRegistrationIntent: vi.fn(async () => activeIntent()),
    secretReader: {
      readTradingApiPrivateKey: vi.fn(async () => PRIVATE_KEY),
    },
    keyChecker: {
      source: "official_lighter_signer",
      check: vi.fn(async () => ({ publicKey: PUBLIC_KEY })),
    },
    client: {
      getApiKeys: vi.fn(async () => ({
        code: 200,
        api_keys: [{
          account_index: 42,
          api_key_index: 4,
          nonce: 1,
          public_key: PUBLIC_KEY,
          transaction_time: 1,
        }],
      })),
      getNextNonce: vi.fn(async () => ({ code: 200, nonce: 1 })),
    },
    findNonceState: vi.fn(async () => observedNonce()),
    ...overrides,
  };
}

describe("managed Lighter trading readiness", () => {
  it("requires the active managed vault scope, durable activation, exact key, client check, and nonce", async () => {
    const result = await resolveManagedLighterTradingReadiness("core", 42, deps());

    expect(result).toEqual({
      ready: true,
      reason: "ready",
      activeManagedCredential: true,
      durableActivation: true,
      exactPublicKeyMatch: true,
      clientCheckPassed: true,
      nonceSynchronized: true,
      nonceReservable: true,
    });
    expect(JSON.stringify(result)).not.toContain(PRIVATE_KEY);
  });

  it("proves Robinhood Chain readiness through the exact RHC key and nonce scope", async () => {
    const setup = deps({
      listManagedScopes: vi.fn((_environment: "core" | "rhc") => [{
        environment: "rhc" as const,
        accountIndex: 42,
        apiKeyIndex: 4,
      }]),
      findRegistrationIntent: vi.fn(async () => activeIntent({
        environment: "rhc",
        chainId: 4663,
        vaultCredentialId: "lighter/rhc/account-42/api-key-4",
      })),
      findNonceState: vi.fn(async () => observedNonce({ environment: "rhc" })),
    });

    const result = await resolveManagedLighterTradingReadiness("rhc", 42, setup);

    expect(result).toMatchObject({ ready: true, reason: "ready" });
    expect(setup.listManagedScopes).toHaveBeenCalledWith("rhc");
    expect(setup.findRegistrationIntent).toHaveBeenCalledWith("rhc", 42);
    expect(setup.client.getApiKeys).toHaveBeenCalledWith("rhc", {
      accountIndex: 42,
      apiKeyIndex: 4,
    });
    expect(setup.client.getNextNonce).toHaveBeenCalledWith("rhc", {
      accountIndex: 42,
      apiKeyIndex: 4,
    });
    expect(setup.keyChecker.check).toHaveBeenCalledWith(expect.objectContaining({
      environment: "rhc",
    }));
  });

  it("does not accept an imported or pending credential as managed readiness", async () => {
    const setup = deps({ listManagedScopes: () => [] });

    const result = await resolveManagedLighterTradingReadiness("core", 42, setup);

    expect(result).toMatchObject({
      ready: false,
      reason: "active_managed_credential_missing",
      activeManagedCredential: false,
    });
    expect(setup.findRegistrationIntent).not.toHaveBeenCalled();
    expect(setup.keyChecker.check).not.toHaveBeenCalled();
  });

  it("fails closed when the live slot no longer holds the activated key", async () => {
    const setup = deps();
    vi.mocked(setup.client.getApiKeys).mockResolvedValue({
      code: 200,
      api_keys: [{
        account_index: 42,
        api_key_index: 4,
        nonce: 1,
        public_key: OTHER_PUBLIC_KEY,
        transaction_time: 1,
      }],
    });

    const result = await resolveManagedLighterTradingReadiness("core", 42, setup);

    expect(result).toMatchObject({
      ready: false,
      reason: "live_key_mismatch",
      exactPublicKeyMatch: false,
    });
    expect(setup.secretReader.readTradingApiPrivateKey).not.toHaveBeenCalled();
    expect(setup.keyChecker.check).not.toHaveBeenCalled();
  });

  it("does not report ready while a local nonce reservation is unresolved", async () => {
    const setup = deps({
      findNonceState: vi.fn(async () => observedNonce({
        status: "reserved",
        reservedNonce: "1",
        reservationId: "lighter-order:stuck",
      })),
    });

    const result = await resolveManagedLighterTradingReadiness("core", 42, setup);

    expect(result).toMatchObject({
      ready: false,
      reason: "nonce_not_reservable",
      nonceSynchronized: true,
      nonceReservable: false,
    });
  });
});
