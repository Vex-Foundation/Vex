import { describe, expect, it, vi } from "vitest";

import { mapLighterError } from "@tools/lighter/errors.js";
import type { LighterChangePubKeySignerResult } from "@tools/lighter/change-pub-key.js";
import type { EvmWallet } from "@tools/wallet/multi-auth.js";
import type { LighterKeyRegistrationReservationRow } from "@vex-agent/db/repos/lighter-key-registration-intents.js";
import {
  executeApprovedLighterKeyRegistration,
  reconcileLighterKeyRegistration,
  type LighterKeyRegistrationExecutionDeps,
} from "../key-registration-execution.js";

const PUBLIC_KEY = "b".repeat(80);
const OTHER_PUBLIC_KEY = "c".repeat(80);
const TX_HASH = "a".repeat(80);
const LIGHTER_PRIVATE_KEY = `0x${"1".repeat(80)}`;
const WALLET: EvmWallet = {
  family: "eip155",
  address: "0x1111111111111111111111111111111111111111",
  privateKey: `0x${"2".repeat(64)}`,
};

function intent(
  executionState: LighterKeyRegistrationReservationRow["executionState"] = "approved",
): LighterKeyRegistrationReservationRow {
  const now = new Date("2026-08-17T12:00:00.000Z");
  return {
    intentId: "lighter-keyreg-1",
    sessionId: "session-1",
    environment: "core",
    walletAddress: WALLET.address,
    chainId: 1,
    accountIndex: 42,
    apiKeyIndex: 7,
    slotObservedAt: now,
    slotObservationHash: "d".repeat(64),
    approvalStatus: "approved",
    executionState,
    vaultCredentialId: "lighter/core/account-42/api-key-7",
    publicKey: PUBLIC_KEY,
    publicKeyFingerprint: "e".repeat(64),
    keyGeneratedAt: now,
    registrationNonce: "0",
    registrationNonceObservedAt: now,
    registrationTxType: executionState === "approved" ? null : 8,
    registrationTxHash: executionState === "approved" ? null : TX_HASH,
    registrationTxExpiredAt: executionState === "approved" ? null : "1893456000000",
    registrationTxStagedAt: executionState === "approved" ? null : now,
    registrationSubmittedTxHash: null,
    registrationSubmitCode: null,
    registrationPredictedExecutionTimeMs: null,
    registrationSubmitAcceptedAt: null,
    registrationAmbiguityReason: null,
    registrationKeyVerifiedAt: null,
    registrationClientCheckedAt: null,
    postRegistrationNonce: null,
    registrationNonceSynchronizedAt: null,
    registrationActivatedAt: null,
    createdAt: now,
    updatedAt: now,
    expiresAt: new Date("2026-08-17T13:00:00.000Z"),
  };
}

function signedResult(): LighterChangePubKeySignerResult {
  return {
    kind: "lighter_change_pub_key_signer_result",
    environment: "core",
    accountIndex: 42,
    apiKeyIndex: 7,
    nonce: "0",
    expiredAt: "1893456000000",
    publicKey: PUBLIC_KEY,
    expectedL1Address: WALLET.address,
    messageToSign: "Register Lighter Account",
    txType: 8,
    txInfo: "{\"signed\":true}",
    txHash: TX_HASH,
  };
}

function slot(publicKey = PUBLIC_KEY) {
  return {
    account_index: 42,
    api_key_index: 7,
    nonce: 1,
    public_key: publicKey,
    transaction_time: 1,
  };
}

function makeDeps(options: {
  readonly sendTx?: () => Promise<{
    code: number;
    message?: string;
    tx_hash: string;
    predicted_execution_time_ms: number;
  }>;
  readonly reconciliationPublicKey?: string | null;
  readonly ownedAccount?: boolean;
  readonly postRegistrationNonce?: number;
  readonly checkerPublicKey?: string;
  readonly initialExecutionState?: LighterKeyRegistrationReservationRow["executionState"];
  readonly missingSlotResponse?: "empty" | "not_found" | "other_error";
} = {}) {
  const initiallyApproved = (options.initialExecutionState ?? "approved") === "approved";
  let current = intent(options.initialExecutionState);
  let apiKeyReadCount = 0;
  let nonceReadCount = 0;
  const events: string[] = [];
  const markAmbiguous = vi.fn(async (
    _sessionId: string,
    _intentId: string,
    input: { readonly reason: string },
  ) => {
    events.push(`ambiguous:${input.reason}`);
    current = { ...current, executionState: "ambiguous", registrationAmbiguityReason: input.reason };
    return current;
  });
  const activateVaultCredential = vi.fn(() => ({
    present: true as const,
    reference: {
      kind: "encrypted_vault_reference" as const,
      environment: "core" as const,
      accountIndex: 42,
      apiKeyIndex: 7,
      vaultCredentialId: "lighter/core/account-42/api-key-7",
    },
    registrationState: "key_registered_active" as const,
  }));
  const deps: LighterKeyRegistrationExecutionDeps = {
    client: {
      getAccountsByL1Address: vi.fn(async () => ({
        code: 200,
        l1_address: WALLET.address,
        sub_accounts: options.ownedAccount === false ? [] : [{
          account_type: 0,
          index: 42,
          l1_address: WALLET.address,
        }],
      })),
      getApiKeys: vi.fn(async () => {
        apiKeyReadCount += 1;
        if (initiallyApproved && apiKeyReadCount === 1) {
          if (options.missingSlotResponse === "not_found") {
            throw mapLighterError("core", 400, { message: "api key not found" });
          }
          if (options.missingSlotResponse === "other_error") {
            throw mapLighterError("core", 400, { message: "invalid account index" });
          }
        }
        const publicKey = initiallyApproved && apiKeyReadCount === 1
          ? null
          : options.reconciliationPublicKey;
        return { code: 200, api_keys: publicKey === null ? [] : [slot(publicKey ?? PUBLIC_KEY)] };
      }),
      getNextNonce: vi.fn(async () => {
        nonceReadCount += 1;
        return {
          code: 200,
          nonce: initiallyApproved && nonceReadCount === 1
            ? 0
            : (options.postRegistrationNonce ?? 1),
        };
      }),
      sendTx: vi.fn(options.sendTx ?? (async () => {
        events.push("sendTx");
        return { code: 200, tx_hash: TX_HASH, predicted_execution_time_ms: 25 };
      })),
    },
    readIntent: vi.fn(async () => current),
    integrationEnabled: vi.fn(async () => true),
    releaseGateEnabled: vi.fn(() => true),
    resolveWallet: vi.fn(() => WALLET),
    sign: vi.fn(async () => {
      events.push("sign");
      return signedResult();
    }),
    keyGenerator: {
      source: "official_lighter_signer",
      generate: vi.fn(),
      derivePublicKey: vi.fn(async () => PUBLIC_KEY),
    },
    keyChecker: {
      source: "official_lighter_signer",
      check: vi.fn(async () => ({ publicKey: options.checkerPublicKey ?? PUBLIC_KEY })),
    },
    readVaultPrivateKey: vi.fn(() => LIGHTER_PRIVATE_KEY),
    readVaultRegistrationState: vi.fn(() => "key_generated_pending_registration" as const),
    activateVaultCredential,
    markStaged: vi.fn(async (_sessionId, _intentId, input) => {
      events.push("stage");
      current = {
        ...current,
        executionState: "key_registration_tx_staged",
        registrationTxType: input.txType,
        registrationTxHash: input.txHash,
        registrationTxExpiredAt: input.expiredAt,
        registrationTxStagedAt: input.stagedAt,
      };
      return current;
    }),
    markSubmitted: vi.fn(async (_sessionId, _intentId, input) => {
      events.push("submitted");
      current = {
        ...current,
        executionState: "change_pub_key_submitted",
        registrationSubmittedTxHash: input.submittedTxHash,
      };
      return current;
    }),
    markAmbiguous: markAmbiguous as LighterKeyRegistrationExecutionDeps["markAmbiguous"],
    markKeyVerified: vi.fn(async () => {
      events.push("verified");
      current = { ...current, executionState: "key_verified" };
      return current;
    }),
    markNonceSynchronized: vi.fn(async (_sessionId, _intentId, input) => {
      events.push("nonce");
      current = { ...current, executionState: "nonce_synchronized", postRegistrationNonce: input.nextNonce };
      return current;
    }),
    markActive: vi.fn(async () => {
      events.push("active-db");
      current = { ...current, executionState: "active" };
      return current;
    }),
    now: vi.fn(() => new Date("2026-08-17T12:01:00.000Z")),
    sleep: vi.fn(async () => undefined),
    reconciliationAttempts: 1,
  };
  return { deps, events, activateVaultCredential, markAmbiguous };
}

const EXECUTION_INPUT = {
  sessionId: "session-1",
  intentId: "lighter-keyreg-1",
  walletResolution: { source: "default" } as const,
  walletPolicy: { kind: "none" } as const,
};

describe("Lighter key registration execution", () => {
  it("stages before sendTx and activates only after exact key, CheckClient, and nonce +1", async () => {
    const setup = makeDeps({
      reconciliationPublicKey: PUBLIC_KEY,
      missingSlotResponse: "not_found",
    });

    const result = await executeApprovedLighterKeyRegistration(EXECUTION_INPUT, setup.deps);

    expect(result).toMatchObject({
      status: "active",
      executionState: "active",
      txHash: TX_HASH,
      postRegistrationNonce: "1",
    });
    expect(setup.events).toEqual([
      "sign",
      "stage",
      "sendTx",
      "submitted",
      "verified",
      "nonce",
      "active-db",
    ]);
    expect(setup.deps.keyChecker.check).toHaveBeenCalledOnce();
    expect(setup.activateVaultCredential).toHaveBeenCalledOnce();
    expect(JSON.stringify(result)).not.toContain(LIGHTER_PRIVATE_KEY);
    expect(JSON.stringify(result)).not.toContain("signed");
  });

  it("does not treat unrelated exact-slot 400 responses as vacancy", async () => {
    const setup = makeDeps({
      reconciliationPublicKey: PUBLIC_KEY,
      missingSlotResponse: "other_error",
    });

    await expect(executeApprovedLighterKeyRegistration(EXECUTION_INPUT, setup.deps))
      .rejects.toThrow("invalid account index");
    expect(setup.deps.resolveWallet).not.toHaveBeenCalled();
    expect(setup.deps.sign).not.toHaveBeenCalled();
    expect(setup.deps.client.sendTx).not.toHaveBeenCalled();
  });

  it("records an uncertain send once and never resubmits while the slot is absent", async () => {
    const setup = makeDeps({
      reconciliationPublicKey: null,
      sendTx: async () => {
        setup.events.push("sendTx");
        throw new Error(`raw provider body ${LIGHTER_PRIVATE_KEY}`);
      },
    });

    const result = await executeApprovedLighterKeyRegistration(EXECUTION_INPUT, setup.deps);

    expect(result.status).toBe("ambiguity_unresolved");
    expect(setup.deps.client.sendTx).toHaveBeenCalledOnce();
    expect(setup.markAmbiguous).toHaveBeenCalledWith(
      "session-1",
      "lighter-keyreg-1",
      expect.objectContaining({ reason: "send_tx_outcome_unknown" }),
    );
    expect(setup.activateVaultCredential).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(LIGHTER_PRIVATE_KEY);
  });

  it("refuses a different registered key and keeps the local credential inactive", async () => {
    const setup = makeDeps({ reconciliationPublicKey: OTHER_PUBLIC_KEY });

    const result = await executeApprovedLighterKeyRegistration(EXECUTION_INPUT, setup.deps);

    expect(result.status).toBe("registered_key_conflict");
    expect(setup.markAmbiguous).toHaveBeenCalledWith(
      "session-1",
      "lighter-keyreg-1",
      expect.objectContaining({ reason: "registered_public_key_conflict" }),
    );
    expect(setup.deps.keyChecker.check).not.toHaveBeenCalled();
    expect(setup.activateVaultCredential).not.toHaveBeenCalled();
  });

  it("checks exact wallet ownership before resolving or decrypting a signing wallet", async () => {
    const setup = makeDeps({ ownedAccount: false, reconciliationPublicKey: PUBLIC_KEY });

    await expect(executeApprovedLighterKeyRegistration(EXECUTION_INPUT, setup.deps))
      .rejects.toThrow("not uniquely owned");
    expect(setup.deps.resolveWallet).not.toHaveBeenCalled();
    expect(setup.deps.sign).not.toHaveBeenCalled();
    expect(setup.deps.client.sendTx).not.toHaveBeenCalled();
  });

  it("keeps the credential inactive when CheckClient does not confirm the vault key", async () => {
    const setup = makeDeps({
      reconciliationPublicKey: PUBLIC_KEY,
      checkerPublicKey: OTHER_PUBLIC_KEY,
    });

    await expect(executeApprovedLighterKeyRegistration(EXECUTION_INPUT, setup.deps))
      .rejects.toThrow("official client check returned a different public key");
    expect(setup.activateVaultCredential).not.toHaveBeenCalled();
  });

  it("keeps the credential inactive until the public nonce is exactly approved nonce plus one", async () => {
    const setup = makeDeps({
      reconciliationPublicKey: PUBLIC_KEY,
      postRegistrationNonce: 2,
    });

    const result = await executeApprovedLighterKeyRegistration(EXECUTION_INPUT, setup.deps);

    expect(result.status).toBe("key_verified_pending_nonce");
    expect(result.executionState).toBe("key_verified");
    expect(setup.activateVaultCredential).not.toHaveBeenCalled();
  });

  it("reconciles a submitted transaction without reaching any signing or sendTx path", async () => {
    const setup = makeDeps({
      initialExecutionState: "change_pub_key_submitted",
      reconciliationPublicKey: PUBLIC_KEY,
    });

    const result = await reconcileLighterKeyRegistration(EXECUTION_INPUT, setup.deps);

    expect(result.status).toBe("active");
    expect(setup.deps.resolveWallet).not.toHaveBeenCalled();
    expect(setup.deps.sign).not.toHaveBeenCalled();
    expect(setup.deps.client.sendTx).not.toHaveBeenCalled();
    expect(setup.deps.integrationEnabled).not.toHaveBeenCalled();
    expect(setup.deps.releaseGateEnabled).not.toHaveBeenCalled();
  });

  it("refuses evidence-only reconciliation before a transaction is staged", async () => {
    const setup = makeDeps({ reconciliationPublicKey: PUBLIC_KEY });

    await expect(reconcileLighterKeyRegistration(EXECUTION_INPUT, setup.deps))
      .rejects.toThrow("no staged transaction to reconcile");
    expect(setup.deps.sign).not.toHaveBeenCalled();
    expect(setup.deps.client.sendTx).not.toHaveBeenCalled();
  });
});
