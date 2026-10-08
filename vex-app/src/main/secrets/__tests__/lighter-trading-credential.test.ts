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
const mockWriteSecretVaultExtraSecrets = vi.fn();

vi.mock("../session.js", () => ({
  requireUnlockedMasterPassword: () => mockRequireUnlockedMasterPassword(),
}));

vi.mock("@vex-lib/local-secret-vault.js", () => ({
  unlockSecretVault: (...args: unknown[]) => mockUnlockSecretVault(...args),
  writeSecretVaultExtraSecrets: (...args: unknown[]) =>
    mockWriteSecretVaultExtraSecrets(...args),
}));

vi.mock("../../paths/config-dir.js", () => ({
  SECRETS_VAULT_FILE: "/tmp/vex-test-vault",
}));

async function loadModule(): Promise<typeof import("../lighter-trading-credential.js")> {
  vi.resetModules();
  return import("../lighter-trading-credential.js");
}

/**
 * The session's own vault options (`VAULT_DERIVED_KEY_CACHE`), taken from the
 * same module graph `loadModule` just loaded, so the cache instance compares
 * equal to the one the code under test passed.
 */
async function sessionVaultOptions(
  label: import("../vault-key-cache.js").UnlockedVaultOperationLabel,
): Promise<import("@vex-lib/local-secret-vault/derived-key-cache.js").LocalSecretVaultCacheOptions> {
  const { unlockedSessionVaultOptions } = await import("../vault-key-cache.js");
  return unlockedSessionVaultOptions(label);
}

beforeEach(() => {
  mockRequireUnlockedMasterPassword.mockReset();
  mockUnlockSecretVault.mockReset();
  mockWriteSecretVaultExtraSecrets.mockReset();
  delete process.env[REFERENCE.vaultCredentialId];
});

describe("Lighter trading credential vault reader", () => {
  it("reads a matching Lighter trading key from vault extraSecrets only", async () => {
    mockRequireUnlockedMasterPassword.mockReturnValue({ ok: true, data: "correct-password" });
    mockUnlockSecretVault.mockResolvedValue({
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
    expect(mockUnlockSecretVault).toHaveBeenCalledTimes(2);
    expect(mockUnlockSecretVault).toHaveBeenNthCalledWith(
      1,
      "correct-password",
      await sessionVaultOptions("lighter_registration_state"),
    );
    expect(mockUnlockSecretVault).toHaveBeenNthCalledWith(
      2,
      "correct-password",
      await sessionVaultOptions("lighter_key"),
    );
    expect(JSON.stringify(material)).toBe(
      "{\"kind\":\"lighter_api_private_key_secret\",\"privateKey\":\"[redacted]\"}",
    );
  });

  it("does not fall back to environment variables", async () => {
    process.env[REFERENCE.vaultCredentialId] = PRIVATE_KEY;
    mockRequireUnlockedMasterPassword.mockReturnValue({ ok: true, data: "correct-password" });
    mockUnlockSecretVault.mockResolvedValue({
      version: 1,
      secrets: {},
      extraSecrets: {},
    });
    const { readUnlockedLighterTradingApiPrivateKey } = await loadModule();

    expect(await readUnlockedLighterTradingApiPrivateKey(REFERENCE)).toBeNull();
  });

  it("does not expose a pending generated key to the order-signing reader", async () => {
    mockRequireUnlockedMasterPassword.mockReturnValue({ ok: true, data: "correct-password" });
    mockUnlockSecretVault.mockResolvedValue({
      version: 1,
      secrets: {},
      extraSecrets: {
        [REFERENCE.vaultCredentialId]: PRIVATE_KEY,
        [`${REFERENCE.vaultCredentialId}/registration-state`]:
          "key_generated_pending_registration",
      },
    });
    const { createUnlockedVaultLighterTradingSecretReader } = await loadModule();

    await expect(
      createUnlockedVaultLighterTradingSecretReader().readTradingApiPrivateKey(REFERENCE),
    ).resolves.toBeNull();
  });

  it("rejects references that do not match the approved Lighter scope", async () => {
    mockRequireUnlockedMasterPassword.mockReturnValue({ ok: true, data: "correct-password" });
    const { readUnlockedLighterTradingApiPrivateKey } = await loadModule();

    await expect(readUnlockedLighterTradingApiPrivateKey({
      ...REFERENCE,
      vaultCredentialId: "lighter/rhc/account-42/api-key-8",
    })).rejects.toThrow("does not match");
    expect(mockUnlockSecretVault).not.toHaveBeenCalled();
  });

  it("fails closed without echoing credential material when the vault cannot be read", async () => {
    mockRequireUnlockedMasterPassword.mockReturnValue({ ok: true, data: "correct-password" });
    mockUnlockSecretVault.mockImplementation(async () => {
      throw new Error(`raw secret ${PRIVATE_KEY}`);
    });
    const { readUnlockedLighterTradingApiPrivateKey } = await loadModule();

    await expect(readUnlockedLighterTradingApiPrivateKey(REFERENCE))
      .rejects.toThrow("privileged vault boundary");
    await expect(readUnlockedLighterTradingApiPrivateKey(REFERENCE))
      .rejects.not.toThrow(PRIVATE_KEY);
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

    await expect(readUnlockedLighterTradingApiPrivateKey(REFERENCE))
      .rejects.toThrow("local vault is locked");
    expect(mockUnlockSecretVault).not.toHaveBeenCalled();
  });
});

describe("Lighter trading credential vault import", () => {
  it("atomically stores a generated key with its pending-registration marker", async () => {
    mockRequireUnlockedMasterPassword.mockReturnValue({ ok: true, data: "correct-password" });
    mockUnlockSecretVault.mockResolvedValue({ version: 1, secrets: {}, extraSecrets: {} });
    mockWriteSecretVaultExtraSecrets.mockResolvedValue({ version: 1, secrets: {} });
    const {
      LIGHTER_TRADING_CREDENTIAL_PENDING_REGISTRATION_STATE,
      writeUnlockedPendingLighterTradingApiPrivateKey,
    } = await loadModule();

    const status = await writeUnlockedPendingLighterTradingApiPrivateKey(REFERENCE, PRIVATE_KEY);

    expect(status).toEqual({
      present: true,
      reference: REFERENCE,
      registrationState: LIGHTER_TRADING_CREDENTIAL_PENDING_REGISTRATION_STATE,
    });
    expect(mockWriteSecretVaultExtraSecrets).toHaveBeenCalledWith(
      "correct-password",
      {
        [REFERENCE.vaultCredentialId]: PRIVATE_KEY,
        [`${REFERENCE.vaultCredentialId}/registration-state`]:
          "key_generated_pending_registration",
      },
      await sessionVaultOptions("lighter_write"),
    );
  });

  it("resumes an identical pending credential without rewriting the vault", async () => {
    mockRequireUnlockedMasterPassword.mockReturnValue({ ok: true, data: "correct-password" });
    mockUnlockSecretVault.mockResolvedValue({
      version: 1,
      secrets: {},
      extraSecrets: {
        [REFERENCE.vaultCredentialId]: PRIVATE_KEY,
        [`${REFERENCE.vaultCredentialId}/registration-state`]:
          "key_generated_pending_registration",
      },
    });
    const { writeUnlockedPendingLighterTradingApiPrivateKey } = await loadModule();

    expect(await writeUnlockedPendingLighterTradingApiPrivateKey(REFERENCE, PRIVATE_KEY))
      .toMatchObject({ present: true, registrationState: "key_generated_pending_registration" });
    expect(mockWriteSecretVaultExtraSecrets).not.toHaveBeenCalled();
  });

  it("never overwrites conflicting pending vault material", async () => {
    mockRequireUnlockedMasterPassword.mockReturnValue({ ok: true, data: "correct-password" });
    mockUnlockSecretVault.mockResolvedValue({
      version: 1,
      secrets: {},
      extraSecrets: {
        [REFERENCE.vaultCredentialId]: `0x${"2".repeat(80)}`,
        [`${REFERENCE.vaultCredentialId}/registration-state`]:
          "key_generated_pending_registration",
      },
    });
    const { writeUnlockedPendingLighterTradingApiPrivateKey } = await loadModule();

    await expect(writeUnlockedPendingLighterTradingApiPrivateKey(REFERENCE, PRIVATE_KEY))
      .rejects.toThrow("conflicts with existing local vault state");
    expect(mockWriteSecretVaultExtraSecrets).not.toHaveBeenCalled();
  });

  it("runs concurrent pending saves one at a time so only one passes the conflict check", async () => {
    mockRequireUnlockedMasterPassword.mockReturnValue({ ok: true, data: "correct-password" });
    // A tiny in-memory vault: each read sees every write that finished before it.
    let extraSecrets: Record<string, string> = {};
    mockUnlockSecretVault.mockImplementation(async () => ({
      version: 1,
      secrets: {},
      extraSecrets: { ...extraSecrets },
    }));
    mockWriteSecretVaultExtraSecrets.mockImplementation(
      async (_password: string, updates: Record<string, string | null>) => {
        const next = { ...extraSecrets };
        for (const [key, value] of Object.entries(updates)) {
          if (value === null) delete next[key];
          else next[key] = value;
        }
        extraSecrets = next;
        return { version: 1, secrets: {}, extraSecrets: next };
      },
    );
    const { writeUnlockedPendingLighterTradingApiPrivateKey } = await loadModule();

    const [first, second] = await Promise.allSettled([
      writeUnlockedPendingLighterTradingApiPrivateKey(REFERENCE, PRIVATE_KEY),
      writeUnlockedPendingLighterTradingApiPrivateKey(REFERENCE, `0x${"2".repeat(80)}`),
    ]);

    expect(first.status).toBe("fulfilled");
    expect(second.status).toBe("rejected");
    if (second.status === "rejected") {
      expect(String(second.reason)).toContain("conflicts with existing local vault state");
    }
    expect(mockWriteSecretVaultExtraSecrets).toHaveBeenCalledTimes(1);
    expect(extraSecrets[REFERENCE.vaultCredentialId]).toBe(PRIVATE_KEY);
  });

  it("writes a validated key into vault extraSecrets only", async () => {
    mockRequireUnlockedMasterPassword.mockReturnValue({ ok: true, data: "correct-password" });
    mockWriteSecretVaultExtraSecrets.mockResolvedValue({
      version: 1,
      secrets: {},
      extraSecrets: {
        [REFERENCE.vaultCredentialId]: PRIVATE_KEY,
      },
    });
    const { writeUnlockedLighterTradingApiPrivateKey } = await loadModule();

    const status = await writeUnlockedLighterTradingApiPrivateKey(
      REFERENCE,
      `  ${PRIVATE_KEY}  `,
    );

    expect(status).toEqual({ present: true, reference: REFERENCE });
    expect(mockWriteSecretVaultExtraSecrets).toHaveBeenCalledWith(
      "correct-password",
      { [REFERENCE.vaultCredentialId]: PRIVATE_KEY },
      await sessionVaultOptions("lighter_write"),
    );
    expect(mockUnlockSecretVault).not.toHaveBeenCalled();
  });

  it("rejects invalid key material before touching the vault", async () => {
    mockRequireUnlockedMasterPassword.mockReturnValue({ ok: true, data: "correct-password" });
    const { writeUnlockedLighterTradingApiPrivateKey } = await loadModule();

    await expect(
      writeUnlockedLighterTradingApiPrivateKey(
        REFERENCE,
        "ro:42:single:4102444800:abcdef",
      ),
    ).rejects.toThrow("Read-only Lighter tokens cannot sign");
    expect(mockWriteSecretVaultExtraSecrets).not.toHaveBeenCalled();
    expect(mockUnlockSecretVault).not.toHaveBeenCalled();
  });

  it("rejects mismatched references before validating or writing", async () => {
    mockRequireUnlockedMasterPassword.mockReturnValue({ ok: true, data: "correct-password" });
    const { writeUnlockedLighterTradingApiPrivateKey } = await loadModule();

    await expect(
      writeUnlockedLighterTradingApiPrivateKey(
        { ...REFERENCE, vaultCredentialId: "lighter/rhc/account-42/api-key-8" },
        PRIVATE_KEY,
      ),
    ).rejects.toThrow("does not match");
    expect(mockWriteSecretVaultExtraSecrets).not.toHaveBeenCalled();
  });

  it("fails closed without echoing credential material when import fails", async () => {
    mockRequireUnlockedMasterPassword.mockReturnValue({ ok: true, data: "correct-password" });
    mockWriteSecretVaultExtraSecrets.mockImplementation(async () => {
      throw new Error(`raw secret ${PRIVATE_KEY}`);
    });
    const { writeUnlockedLighterTradingApiPrivateKey } = await loadModule();

    let caught: unknown = null;
    try {
      await writeUnlockedLighterTradingApiPrivateKey(REFERENCE, PRIVATE_KEY);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect(String(caught)).toContain("could not be saved");
    expect(String(caught)).not.toContain(PRIVATE_KEY);
  });

  it("fails closed while the vault is locked", async () => {
    mockRequireUnlockedMasterPassword.mockReturnValue({
      ok: false,
      error: {
        code: "wallet.keystore_locked",
        message: "raw internal detail",
      },
    });
    const { writeUnlockedLighterTradingApiPrivateKey } = await loadModule();

    await expect(
      writeUnlockedLighterTradingApiPrivateKey(REFERENCE, PRIVATE_KEY),
    ).rejects.toThrow("local vault is locked");
    expect(mockWriteSecretVaultExtraSecrets).not.toHaveBeenCalled();
  });
});

describe("Lighter trading credential vault status and removal", () => {
  it("reads the pending-registration marker without returning key material", async () => {
    mockRequireUnlockedMasterPassword.mockReturnValue({ ok: true, data: "correct-password" });
    mockUnlockSecretVault.mockResolvedValue({
      version: 1,
      secrets: {},
      extraSecrets: {
        [REFERENCE.vaultCredentialId]: PRIVATE_KEY,
        [`${REFERENCE.vaultCredentialId}/registration-state`]:
          "key_generated_pending_registration",
      },
    });
    const { getUnlockedLighterTradingCredentialRegistrationState } = await loadModule();

    const state = await getUnlockedLighterTradingCredentialRegistrationState(REFERENCE);
    expect(state).toBe("key_generated_pending_registration");
    expect(JSON.stringify(state)).not.toContain(PRIVATE_KEY);
  });

  it("reports presence without returning key material", async () => {
    mockRequireUnlockedMasterPassword.mockReturnValue({ ok: true, data: "correct-password" });
    mockUnlockSecretVault.mockResolvedValue({
      version: 1,
      secrets: {},
      extraSecrets: {
        [REFERENCE.vaultCredentialId]: PRIVATE_KEY,
      },
    });
    const { getUnlockedLighterTradingCredentialStatus } = await loadModule();

    const status = await getUnlockedLighterTradingCredentialStatus(REFERENCE);

    expect(status).toEqual({ present: true, reference: REFERENCE });
    expect(JSON.stringify(status)).not.toContain(PRIVATE_KEY);
  });

  it("promotes a pending key marker to active without rewriting key material", async () => {
    mockRequireUnlockedMasterPassword.mockReturnValue({ ok: true, data: "correct-password" });
    mockUnlockSecretVault.mockResolvedValue({
      version: 1,
      secrets: {},
      extraSecrets: {
        [REFERENCE.vaultCredentialId]: PRIVATE_KEY,
        [`${REFERENCE.vaultCredentialId}/registration-state`]:
          "key_generated_pending_registration",
      },
    });
    const { activateUnlockedLighterTradingCredential } = await loadModule();

    expect(await activateUnlockedLighterTradingCredential(REFERENCE)).toEqual({
      present: true,
      reference: REFERENCE,
      registrationState: "key_registered_active",
    });
    expect(mockWriteSecretVaultExtraSecrets).toHaveBeenCalledWith(
      "correct-password",
      { [`${REFERENCE.vaultCredentialId}/registration-state`]: "key_registered_active" },
      await sessionVaultOptions("lighter_write"),
    );
    expect(JSON.stringify(mockWriteSecretVaultExtraSecrets.mock.calls)).not.toContain(PRIVATE_KEY);
  });

  it("reports absence when the matching extra secret is missing", async () => {
    mockRequireUnlockedMasterPassword.mockReturnValue({ ok: true, data: "correct-password" });
    mockUnlockSecretVault.mockResolvedValue({
      version: 1,
      secrets: {},
      extraSecrets: {},
    });
    const { getUnlockedLighterTradingCredentialStatus } = await loadModule();

    expect(await getUnlockedLighterTradingCredentialStatus(REFERENCE)).toEqual({
      present: false,
      reference: REFERENCE,
    });
  });

  it("reports environment-level presence without returning key material", async () => {
    mockRequireUnlockedMasterPassword.mockReturnValue({ ok: true, data: "correct-password" });
    mockUnlockSecretVault.mockResolvedValue({
      version: 1,
      secrets: {},
      extraSecrets: {
        "lighter/rhc/account-1171/api-key-7": PRIVATE_KEY,
        "lighter/rhc/account-1171/api-key-3": PRIVATE_KEY,
        "lighter/core/account-42/api-key-7": "",
      },
    });
    const { hasUnlockedLighterTradingCredential } = await loadModule();

    expect(await hasUnlockedLighterTradingCredential("rhc")).toBe(true);
    expect(await hasUnlockedLighterTradingCredential("core")).toBe(false);
  });

  it("lists saved trading credential scopes without returning key material", async () => {
    mockRequireUnlockedMasterPassword.mockReturnValue({ ok: true, data: "correct-password" });
    mockUnlockSecretVault.mockResolvedValue({
      version: 1,
      secrets: {},
      extraSecrets: {
        "lighter/rhc/account-1171/api-key-9": PRIVATE_KEY,
        "lighter/rhc/account-1171/api-key-9/registration-state":
          "key_generated_pending_registration",
        "lighter/rhc/account-1171/api-key-10": PRIVATE_KEY,
        "lighter/rhc/account-1171/api-key-10/registration-state": "key_registered_active",
        "lighter/rhc/account-1171/api-key-3": PRIVATE_KEY,
        "lighter/rhc/account-1171/api-key-255": PRIVATE_KEY,
        "lighter/core/account-42/api-key-7": PRIVATE_KEY,
        "lighter/core/account-42/api-key-8": "",
        "other/provider/key": PRIVATE_KEY,
      },
    });
    const { listUnlockedLighterTradingCredentialScopes } = await loadModule();

    expect(await listUnlockedLighterTradingCredentialScopes("rhc")).toEqual([
      { environment: "rhc", accountIndex: 1171, apiKeyIndex: 10 },
    ]);
    expect(JSON.stringify(await listUnlockedLighterTradingCredentialScopes())).not.toContain(PRIVATE_KEY);
  });

  it("lists only Vex-managed active credential scopes", async () => {
    mockRequireUnlockedMasterPassword.mockReturnValue({ ok: true, data: "correct-password" });
    mockUnlockSecretVault.mockResolvedValue({
      version: 1,
      secrets: {},
      extraSecrets: {
        "lighter/core/account-737810/api-key-4": PRIVATE_KEY,
        "lighter/core/account-737810/api-key-4/registration-state": "key_registered_active",
        "lighter/core/account-42/api-key-7": PRIVATE_KEY,
        "lighter/rhc/account-1171/api-key-9": PRIVATE_KEY,
        "lighter/rhc/account-1171/api-key-9/registration-state":
          "key_generated_pending_registration",
      },
    });
    const { listUnlockedManagedLighterTradingCredentialScopes } = await loadModule();

    expect(await listUnlockedManagedLighterTradingCredentialScopes("core")).toEqual([
      { environment: "core", accountIndex: 737810, apiKeyIndex: 4 },
    ]);
    expect(await listUnlockedManagedLighterTradingCredentialScopes("rhc")).toEqual([]);
    expect(JSON.stringify(await listUnlockedManagedLighterTradingCredentialScopes())).not
      .toContain(PRIVATE_KEY);
  });

  it("reports environment-level absence while locked", async () => {
    mockRequireUnlockedMasterPassword.mockReturnValue({
      ok: false,
      error: { code: "wallet.keystore_locked", message: "locked" },
    });
    const { hasUnlockedLighterTradingCredential } = await loadModule();

    expect(await hasUnlockedLighterTradingCredential("rhc")).toBe(false);
    expect(mockUnlockSecretVault).not.toHaveBeenCalled();
  });

  it("deletes the matching key from vault extraSecrets", async () => {
    mockRequireUnlockedMasterPassword.mockReturnValue({ ok: true, data: "correct-password" });
    mockWriteSecretVaultExtraSecrets.mockResolvedValue({
      version: 1,
      secrets: {},
    });
    const { deleteUnlockedLighterTradingApiPrivateKey } = await loadModule();

    const status = await deleteUnlockedLighterTradingApiPrivateKey(REFERENCE);

    expect(status).toEqual({ present: false, reference: REFERENCE });
    expect(mockWriteSecretVaultExtraSecrets).toHaveBeenCalledWith(
      "correct-password",
      {
        [REFERENCE.vaultCredentialId]: null,
        [`${REFERENCE.vaultCredentialId}/registration-state`]: null,
      },
      await sessionVaultOptions("lighter_write"),
    );
  });

  it("deletes a multi-environment connection in one vault rewrite", async () => {
    mockRequireUnlockedMasterPassword.mockReturnValue({ ok: true, data: "correct-password" });
    const coreReference: LighterTradingCredentialVaultReference = {
      kind: "encrypted_vault_reference",
      environment: "core",
      accountIndex: 736778,
      apiKeyIndex: 7,
      vaultCredentialId: "lighter/core/account-736778/api-key-7",
    };
    const rhcReference: LighterTradingCredentialVaultReference = {
      kind: "encrypted_vault_reference",
      environment: "rhc",
      accountIndex: 1171,
      apiKeyIndex: 7,
      vaultCredentialId: "lighter/rhc/account-1171/api-key-7",
    };
    const { deleteUnlockedLighterTradingApiPrivateKeys } = await loadModule();

    expect(await deleteUnlockedLighterTradingApiPrivateKeys([
      coreReference,
      rhcReference,
    ])).toEqual([
      { present: false, reference: coreReference },
      { present: false, reference: rhcReference },
    ]);
    expect(mockWriteSecretVaultExtraSecrets).toHaveBeenCalledTimes(1);
    expect(mockWriteSecretVaultExtraSecrets).toHaveBeenCalledWith(
      "correct-password",
      {
        [coreReference.vaultCredentialId]: null,
        [`${coreReference.vaultCredentialId}/registration-state`]: null,
        [rhcReference.vaultCredentialId]: null,
        [`${rhcReference.vaultCredentialId}/registration-state`]: null,
      },
      await sessionVaultOptions("lighter_write"),
    );
  });
});

describe("Lighter trading credential vault writes drop cached read-only order tokens", () => {
  const SCOPE = { environment: "rhc", accountIndex: 42, apiKeyIndex: 7 } as const;

  async function loadWithPrimedCache(): Promise<{
    readonly module: typeof import("../lighter-trading-credential.js");
    readonly cacheSizeAtWrite: () => readonly number[];
  }> {
    const module = await loadModule();
    // Imported after loadModule's resetModules, so this is the very instance
    // the module under test invalidates.
    const { lighterReadAuthCache } = await import("@vex-agent/tools/protocols/lighter/read-auth-cache.js");
    const nowMs = Date.now();
    lighterReadAuthCache.remember(SCOPE, {
      token: "read-only-token",
      publicKey: "a".repeat(80),
      deadlineUnixSeconds: Math.floor(nowMs / 1_000) + 600,
    }, nowMs);
    expect(lighterReadAuthCache.size).toBe(1);
    const sizes: number[] = [];
    mockWriteSecretVaultExtraSecrets.mockImplementation(async () => {
      sizes.push(lighterReadAuthCache.size);
      return { version: 1, secrets: {} };
    });
    return { module, cacheSizeAtWrite: () => sizes };
  }

  it("on an imported key save", async () => {
    mockRequireUnlockedMasterPassword.mockReturnValue({ ok: true, data: "correct-password" });
    const { module, cacheSizeAtWrite } = await loadWithPrimedCache();

    await module.writeUnlockedLighterTradingApiPrivateKey(REFERENCE, PRIVATE_KEY);

    expect(cacheSizeAtWrite()).toEqual([0]);
  });

  it("on a generated pending key save", async () => {
    mockRequireUnlockedMasterPassword.mockReturnValue({ ok: true, data: "correct-password" });
    mockUnlockSecretVault.mockResolvedValue({ version: 1, secrets: {}, extraSecrets: {} });
    const { module, cacheSizeAtWrite } = await loadWithPrimedCache();

    await module.writeUnlockedPendingLighterTradingApiPrivateKey(REFERENCE, PRIVATE_KEY);

    expect(cacheSizeAtWrite()).toEqual([0]);
  });

  it("on activation after registration", async () => {
    mockRequireUnlockedMasterPassword.mockReturnValue({ ok: true, data: "correct-password" });
    mockUnlockSecretVault.mockResolvedValue({
      version: 1,
      secrets: {},
      extraSecrets: {
        [REFERENCE.vaultCredentialId]: PRIVATE_KEY,
        [`${REFERENCE.vaultCredentialId}/registration-state`]:
          "key_generated_pending_registration",
      },
    });
    const { module, cacheSizeAtWrite } = await loadWithPrimedCache();

    await module.activateUnlockedLighterTradingCredential(REFERENCE);

    expect(cacheSizeAtWrite()).toEqual([0]);
  });

  it("on removal", async () => {
    mockRequireUnlockedMasterPassword.mockReturnValue({ ok: true, data: "correct-password" });
    const { module, cacheSizeAtWrite } = await loadWithPrimedCache();

    await module.deleteUnlockedLighterTradingApiPrivateKey(REFERENCE);

    expect(cacheSizeAtWrite()).toEqual([0]);
  });
});

describe("VAULT_DERIVED_KEY_CACHE on the Lighter credential vault calls", () => {
  it("passes the session's derived-key cache to every read and write while ON", async () => {
    mockRequireUnlockedMasterPassword.mockReturnValue({ ok: true, data: "correct-password" });
    mockUnlockSecretVault.mockResolvedValue({
      version: 1,
      secrets: {},
      extraSecrets: { [REFERENCE.vaultCredentialId]: PRIVATE_KEY },
    });
    mockWriteSecretVaultExtraSecrets.mockResolvedValue({ version: 1, secrets: {} });
    const module = await loadModule();
    const { VAULT_DERIVED_KEY_CACHE } = await import("../vault-key-cache.js");
    expect(VAULT_DERIVED_KEY_CACHE).toBe(true);

    await module.getUnlockedLighterTradingCredentialStatus(REFERENCE);
    await module.listUnlockedLighterTradingCredentialScopes("rhc");
    await module.writeUnlockedLighterTradingApiPrivateKey(REFERENCE, PRIVATE_KEY);

    expect(mockUnlockSecretVault.mock.calls.map((call) => call[1])).toEqual([
      await sessionVaultOptions("lighter_status"),
      await sessionVaultOptions("lighter_scopes"),
    ]);
    for (const call of mockUnlockSecretVault.mock.calls) {
      expect(call[1]).toHaveProperty("derivedKeyCache");
    }
    expect(mockWriteSecretVaultExtraSecrets.mock.calls[0]?.[2]).toHaveProperty("derivedKeyCache");
  });

  it("passes exactly today's options (no cache) when switched OFF", async () => {
    mockRequireUnlockedMasterPassword.mockReturnValue({ ok: true, data: "correct-password" });
    mockUnlockSecretVault.mockResolvedValue({
      version: 1,
      secrets: {},
      extraSecrets: { [REFERENCE.vaultCredentialId]: PRIVATE_KEY },
    });
    mockWriteSecretVaultExtraSecrets.mockResolvedValue({ version: 1, secrets: {} });
    const module = await loadModule();
    const { configureVaultDerivedKeyCacheDeps } = await import("../vault-key-cache.js");
    const restore = configureVaultDerivedKeyCacheDeps({ derivedKeyCache: false });
    try {
      const reader = module.createUnlockedVaultLighterTradingSecretReader();
      await expect(reader.readTradingApiPrivateKey(REFERENCE)).resolves.toBe(PRIVATE_KEY);
      await module.writeUnlockedLighterTradingApiPrivateKey(REFERENCE, PRIVATE_KEY);
    } finally {
      restore();
    }

    expect(mockUnlockSecretVault.mock.calls).toEqual([
      ["correct-password", { filePath: "/tmp/vex-test-vault" }],
      ["correct-password", { filePath: "/tmp/vex-test-vault" }],
    ]);
    expect(mockWriteSecretVaultExtraSecrets.mock.calls[0]?.[2]).toEqual({
      filePath: "/tmp/vex-test-vault",
    });
  });
});
