import { describe, expect, it, vi, beforeEach } from "vitest";

import type { LighterTradingCredentialVaultReference } from "@tools/lighter/trading-credentials.js";
import { loadLighterTradingSecretMaterial } from "@tools/lighter/trading-secret.js";

const PRIVATE_KEY = `0x${"1".repeat(80)}`;
const REFERENCE: LighterTradingCredentialVaultReference = {
  kind: "encrypted_vault_reference",
  environment: "rhc",
  accountIndex: 42,
  apiKeyIndex: 7,
  vaultCredentialId: "lighter/rhc/account-42/api-key-7",
};

const mockRequireUnlockedMasterPassword = vi.fn();
const mockUnlockSecretVault = vi.fn();

vi.mock("../session.js", () => ({
  requireUnlockedMasterPassword: () => mockRequireUnlockedMasterPassword(),
}));

vi.mock("@vex-lib/local-secret-vault.js", () => ({
  unlockSecretVault: (...args: unknown[]) => mockUnlockSecretVault(...args),
}));

vi.mock("../../paths/config-dir.js", () => ({
  SECRETS_VAULT_FILE: "/tmp/vex-test-vault",
}));

async function loadModule(): Promise<typeof import("../lighter-trading-credential.js")> {
  vi.resetModules();
  return import("../lighter-trading-credential.js");
}

beforeEach(() => {
  mockRequireUnlockedMasterPassword.mockReset();
  mockUnlockSecretVault.mockReset();
  delete process.env[REFERENCE.vaultCredentialId];
});

describe("Lighter trading credential vault reader", () => {
  it("reads a matching Lighter trading key from vault extraSecrets only", async () => {
    mockRequireUnlockedMasterPassword.mockReturnValue({ ok: true, data: "correct-password" });
    mockUnlockSecretVault.mockReturnValue({
      version: 1,
      secrets: {},
      extraSecrets: {
        [REFERENCE.vaultCredentialId]: PRIVATE_KEY,
      },
    });
    const { createUnlockedVaultLighterTradingSecretReader } = await loadModule();

    const material = await loadLighterTradingSecretMaterial(
      REFERENCE,
      createUnlockedVaultLighterTradingSecretReader(),
    );

    expect(material.privateKey).toBe(PRIVATE_KEY);
    expect(mockUnlockSecretVault).toHaveBeenCalledWith("correct-password", {
      filePath: "/tmp/vex-test-vault",
    });
    expect(JSON.stringify(material)).toBe(
      "{\"kind\":\"lighter_api_private_key_secret\",\"privateKey\":\"[redacted]\"}",
    );
  });

  it("does not fall back to environment variables", async () => {
    process.env[REFERENCE.vaultCredentialId] = PRIVATE_KEY;
    mockRequireUnlockedMasterPassword.mockReturnValue({ ok: true, data: "correct-password" });
    mockUnlockSecretVault.mockReturnValue({
      version: 1,
      secrets: {},
      extraSecrets: {},
    });
    const { readUnlockedLighterTradingApiPrivateKey } = await loadModule();

    expect(readUnlockedLighterTradingApiPrivateKey(REFERENCE)).toBeNull();
  });

  it("rejects references that do not match the approved Lighter scope", async () => {
    mockRequireUnlockedMasterPassword.mockReturnValue({ ok: true, data: "correct-password" });
    const { readUnlockedLighterTradingApiPrivateKey } = await loadModule();

    expect(() => readUnlockedLighterTradingApiPrivateKey({
      ...REFERENCE,
      vaultCredentialId: "lighter/rhc/account-42/api-key-8",
    })).toThrow("does not match");
    expect(mockUnlockSecretVault).not.toHaveBeenCalled();
  });

  it("fails closed without echoing credential material when the vault cannot be read", async () => {
    mockRequireUnlockedMasterPassword.mockReturnValue({ ok: true, data: "correct-password" });
    mockUnlockSecretVault.mockImplementation(() => {
      throw new Error(`raw secret ${PRIVATE_KEY}`);
    });
    const { readUnlockedLighterTradingApiPrivateKey } = await loadModule();

    expect(() => readUnlockedLighterTradingApiPrivateKey(REFERENCE))
      .toThrow("privileged vault boundary");
    expect(() => readUnlockedLighterTradingApiPrivateKey(REFERENCE))
      .not.toThrow(PRIVATE_KEY);
  });

  it("fails closed while the vault is locked", async () => {
    mockRequireUnlockedMasterPassword.mockReturnValue({
      ok: false,
      error: {
        code: "wallet.keystore_locked",
        message: "raw internal detail",
      },
    });
    const { readUnlockedLighterTradingApiPrivateKey } = await loadModule();

    expect(() => readUnlockedLighterTradingApiPrivateKey(REFERENCE))
      .toThrow("local vault is locked");
    expect(mockUnlockSecretVault).not.toHaveBeenCalled();
  });
});
