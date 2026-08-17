import { describe, expect, it, vi } from "vitest";

import { materialFromSecret } from "@tools/lighter/trading-secret.js";
import type { LighterKeyRegistrationReservationRow } from "@vex-agent/db/repos/lighter-key-registration-intents.js";
import {
  prepareLighterRegistrationCredential,
  type PrepareLighterRegistrationCredentialDeps,
} from "../key-registration-credential.js";

const NOW = new Date("2030-01-01T00:00:00.000Z");
const PRIVATE_KEY = `0x${"1".repeat(80)}`;
const PUBLIC_KEY = "ab".repeat(40);
const VAULT_ID = "lighter/core/account-42/api-key-6";

function intent(
  state: LighterKeyRegistrationReservationRow["executionState"] = "slot_reserved",
): LighterKeyRegistrationReservationRow {
  return {
    intentId: "lighter-onboard-1",
    sessionId: "session-1",
    environment: "core",
    walletAddress: "0xacee6141f6171491d34699c9266cb06a41faa43c",
    chainId: 1,
    accountIndex: 42,
    apiKeyIndex: 6,
    slotObservedAt: NOW,
    slotObservationHash: "a".repeat(64),
    approvalStatus: "approval_pending",
    executionState: state,
    vaultCredentialId: state === "key_generated_encrypted" ? VAULT_ID : null,
    publicKey: state === "key_generated_encrypted" ? PUBLIC_KEY : null,
    publicKeyFingerprint: state === "key_generated_encrypted" ? "f".repeat(64) : null,
    keyGeneratedAt: state === "key_generated_encrypted" ? NOW : null,
    createdAt: NOW,
    updatedAt: NOW,
    expiresAt: new Date("2030-01-01T01:00:00.000Z"),
  };
}

function deps(overrides: Partial<PrepareLighterRegistrationCredentialDeps> = {}) {
  const generated = intent("key_generated_encrypted");
  return {
    readIntent: vi.fn().mockResolvedValue(intent()),
    generator: {
      source: "official_lighter_signer" as const,
      generate: vi.fn().mockResolvedValue({
        secret: materialFromSecret(PRIVATE_KEY),
        publicKey: PUBLIC_KEY,
      }),
      derivePublicKey: vi.fn().mockResolvedValue(PUBLIC_KEY),
    },
    readVaultPrivateKey: vi.fn().mockReturnValue(null),
    readVaultRegistrationState: vi.fn().mockReturnValue(null),
    writePendingVaultPrivateKey: vi.fn(),
    persistGeneratedMetadata: vi.fn().mockResolvedValue(generated),
    now: () => NOW,
    ...overrides,
  } satisfies PrepareLighterRegistrationCredentialDeps;
}

describe("Lighter Phase 3 privileged credential preparation", () => {
  it("encrypts the generated key before persisting public metadata", async () => {
    const events: string[] = [];
    const testDeps = deps({
      generator: {
        source: "official_lighter_signer",
        generate: vi.fn().mockImplementation(async () => {
          events.push("generate");
          return { secret: materialFromSecret(PRIVATE_KEY), publicKey: PUBLIC_KEY };
        }),
        derivePublicKey: vi.fn(),
      },
      writePendingVaultPrivateKey: vi.fn().mockImplementation(() => {
        events.push("vault");
      }),
      persistGeneratedMetadata: vi.fn().mockImplementation(async () => {
        events.push("database");
        return intent("key_generated_encrypted");
      }),
    });

    const result = await prepareLighterRegistrationCredential({
      sessionId: "session-1",
      intentId: "lighter-onboard-1",
    }, testDeps);

    expect(events).toEqual(["generate", "vault", "database"]);
    expect(result).toMatchObject({
      outcome: "generated",
      vaultCredentialId: VAULT_ID,
      publicKey: PUBLIC_KEY,
    });
    expect(JSON.stringify(result)).not.toContain(PRIVATE_KEY);
    expect(testDeps.writePendingVaultPrivateKey).toHaveBeenCalledWith(
      expect.objectContaining({ vaultCredentialId: VAULT_ID }),
      PRIVATE_KEY,
    );
  });

  it("recovers a vault-written key after a crash without generating another", async () => {
    const testDeps = deps({
      readVaultPrivateKey: vi.fn().mockReturnValue(PRIVATE_KEY),
      readVaultRegistrationState: vi.fn().mockReturnValue(
        "key_generated_pending_registration",
      ),
    });

    const result = await prepareLighterRegistrationCredential({
      sessionId: "session-1",
      intentId: "lighter-onboard-1",
    }, testDeps);

    expect(result.outcome).toBe("recovered_pending");
    expect(testDeps.generator.generate).not.toHaveBeenCalled();
    expect(testDeps.generator.derivePublicKey).toHaveBeenCalledOnce();
    expect(testDeps.writePendingVaultPrivateKey).not.toHaveBeenCalled();
    expect(testDeps.persistGeneratedMetadata).toHaveBeenCalledOnce();
  });

  it("verifies an already-persisted key against the encrypted vault", async () => {
    const testDeps = deps({
      readIntent: vi.fn().mockResolvedValue(intent("key_generated_encrypted")),
      readVaultPrivateKey: vi.fn().mockReturnValue(PRIVATE_KEY),
      readVaultRegistrationState: vi.fn().mockReturnValue(
        "key_generated_pending_registration",
      ),
    });

    const result = await prepareLighterRegistrationCredential({
      sessionId: "session-1",
      intentId: "lighter-onboard-1",
    }, testDeps);

    expect(result.outcome).toBe("already_persisted");
    expect(testDeps.persistGeneratedMetadata).not.toHaveBeenCalled();
    expect(testDeps.generator.generate).not.toHaveBeenCalled();
  });

  it("fails closed without leaking a key when the post-vault DB write fails", async () => {
    const testDeps = deps({
      persistGeneratedMetadata: vi.fn().mockRejectedValue(
        new Error(`database failed after ${PRIVATE_KEY}`),
      ),
    });

    let caught: unknown;
    try {
      await prepareLighterRegistrationCredential({
        sessionId: "session-1",
        intentId: "lighter-onboard-1",
      }, testDeps);
    } catch (error) {
      caught = error;
    }

    expect(String(caught)).toContain("metadata could not be persisted");
    expect(String(caught)).not.toContain(PRIVATE_KEY);
    expect(testDeps.writePendingVaultPrivateKey).toHaveBeenCalledOnce();
  });

  it("rejects cross-session intent access before touching the helper or vault", async () => {
    const testDeps = deps();

    await expect(prepareLighterRegistrationCredential({
      sessionId: "session-2",
      intentId: "lighter-onboard-1",
    }, testDeps)).rejects.toThrow("belongs to another session");

    expect(testDeps.generator.generate).not.toHaveBeenCalled();
    expect(testDeps.readVaultPrivateKey).not.toHaveBeenCalled();
    expect(testDeps.writePendingVaultPrivateKey).not.toHaveBeenCalled();
  });
});
