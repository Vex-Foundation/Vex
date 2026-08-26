/**
 * Tests for the secret-vault session module.
 *
 * Focuses on the lock/unlock state machine without exercising real scrypt or
 * filesystem IO — the underlying vault library is mocked so we can assert
 * exactly what `lockSecretSession()` zeros out and what `getSecretSessionStatus()`
 * reports.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockApplySecretVaultToProcessEnv = vi.fn();
const mockCreateSecretVault = vi.fn();
const mockGetSecretVaultStatus = vi.fn();
const mockStripManagedSecretsFromDotenvFile = vi.fn();
const mockUnlockSecretVault = vi.fn();
const mockWriteSecretVaultSecrets = vi.fn();
const mockResetProvider = vi.fn();

class LocalSecretVaultErrorMock extends Error {
  constructor(
    message: string,
    readonly code: "missing" | "invalid_password" | "corrupt" | "io" | "incompatible" | "unavailable",
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "LocalSecretVaultError";
  }
}

vi.mock("@vex-lib/local-secret-vault.js", () => ({
  applySecretVaultToProcessEnv: (...args: unknown[]) =>
    mockApplySecretVaultToProcessEnv(...args),
  createSecretVault: (...args: unknown[]) => mockCreateSecretVault(...args),
  getSecretVaultStatus: (...args: unknown[]) =>
    mockGetSecretVaultStatus(...args),
  LocalSecretVaultError: LocalSecretVaultErrorMock,
  stripManagedSecretsFromDotenvFile: (...args: unknown[]) =>
    mockStripManagedSecretsFromDotenvFile(...args),
  unlockSecretVault: (...args: unknown[]) => mockUnlockSecretVault(...args),
  writeSecretVaultSecrets: (...args: unknown[]) =>
    mockWriteSecretVaultSecrets(...args),
}));

vi.mock("@vex-lib/secret-keys.js", () => ({
  MASTER_PASSWORD_ENV_KEY: "VEX_MASTER_PASSWORD",
  VAULT_SECRET_KEYS: ["JUPITER_API_KEY"] as const,
  // Mirror the real composition: master-password key + all vault keys. The
  // relock scrub iterates this, so it must be defined or scrubUnlockedRuntime
  // would iterate `undefined`.
  MANAGED_SECRET_ENV_KEYS: ["VEX_MASTER_PASSWORD", "JUPITER_API_KEY"] as const,
}));

// lockSecretSession dynamically imports the engine inference registry to drop
// the cached provider after a relock (FINDING-security-003). Mock it so the
// test never pulls the real engine graph and we can assert the reset fired.
vi.mock("@vex-agent/inference/registry.js", () => ({
  resetProvider: () => mockResetProvider(),
}));

// A relock also advances the Vex Studio dispatch generation and refuses the
// pending Studio intents (stage A3). Both are dynamically imported for the same
// process-boundary reason as the registry above, and both are mocked here so
// this file keeps testing the lock STATE MACHINE without opening a database
// connection. Their own ordering and failure posture are pinned in
// `session-studio-lock.test.ts`.
vi.mock("@vex-agent/engine/core/approval-runtime.js", () => ({
  advanceStudioDispatchGeneration: vi
    .fn()
    .mockResolvedValue({ ok: true, generation: "2" }),
}));
vi.mock("../../studio/approval-refusals.js", () => ({
  refuseAllPendingStudioIntents: vi.fn().mockResolvedValue(0),
}));

vi.mock("../../paths/config-dir.js", () => ({
  ENV_FILE: "/tmp/vex-test-env",
  SECRETS_VAULT_FILE: "/tmp/vex-test-vault",
}));

vi.mock("../../logger/index.js", () => ({
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

async function loadSession(): Promise<typeof import("../session.js")> {
  vi.resetModules();
  return import("../session.js");
}

beforeEach(() => {
  mockApplySecretVaultToProcessEnv.mockReset();
  mockCreateSecretVault.mockReset();
  mockGetSecretVaultStatus.mockReset();
  mockStripManagedSecretsFromDotenvFile.mockReset();
  mockUnlockSecretVault.mockReset();
  mockWriteSecretVaultSecrets.mockReset();
  mockResetProvider.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("lockSecretSession", () => {
  it("emits secret-free unlock and synchronous lock lifecycle signals", async () => {
    mockGetSecretVaultStatus.mockReturnValue({ configured: true });
    mockUnlockSecretVault.mockReturnValue({ version: 1, secrets: {} });

    const session = await loadSession();
    const events: string[] = [];
    const unsubscribe = session.onSecretSessionLifecycle((state) => {
      events.push(state);
    });

    session.unlockSecretSession("correct-password");
    const lock = session.lockSecretSession();
    // The capability-revocation event happens before lockSecretSession's first
    // await, so streams close even when quit hooks fire-and-forget the promise.
    expect(events).toEqual(["unlocked", "locked"]);
    await lock;
    unsubscribe();

    session.unlockSecretSession("correct-password");
    expect(events).toEqual(["unlocked", "locked"]);
  });

  it("flips status.unlocked back to false after a successful unlock", async () => {
    mockGetSecretVaultStatus.mockReturnValue({ configured: true });
    mockUnlockSecretVault.mockReturnValue({
      version: 1,
      secrets: {},
    });

    const session = await loadSession();
    const unlock = await session.unlockSecretSession("correct-password");
    expect(unlock.ok).toBe(true);
    expect(session.getSecretSessionStatus()).toEqual({
      vaultConfigured: true,
      unlocked: true,
    });

    await session.lockSecretSession();
    expect(session.getSecretSessionStatus()).toEqual({
      vaultConfigured: true,
      unlocked: false,
    });
  });

  it("locks even when never unlocked (idempotent at rest)", async () => {
    mockGetSecretVaultStatus.mockReturnValue({ configured: true });
    const session = await loadSession();
    expect(session.getSecretSessionStatus().unlocked).toBe(false);
    await session.lockSecretSession();
    expect(session.getSecretSessionStatus().unlocked).toBe(false);
  });

  it("is idempotent across repeated calls", async () => {
    mockGetSecretVaultStatus.mockReturnValue({ configured: true });
    mockUnlockSecretVault.mockReturnValue({ version: 1, secrets: {} });

    const session = await loadSession();
    await session.unlockSecretSession("correct-password");
    await session.lockSecretSession();
    await session.lockSecretSession();
    await session.lockSecretSession();
    expect(session.getSecretSessionStatus().unlocked).toBe(false);
  });

  it("requireUnlockedMasterPassword fails after lock", async () => {
    mockGetSecretVaultStatus.mockReturnValue({ configured: true });
    mockUnlockSecretVault.mockReturnValue({ version: 1, secrets: {} });

    const session = await loadSession();
    await session.unlockSecretSession("correct-password");
    expect(session.requireUnlockedMasterPassword().ok).toBe(true);

    await session.lockSecretSession();
    const result = session.requireUnlockedMasterPassword();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("wallet.keystore_locked");
    }
  });

  // ── FINDING-security-003: relock must scrub env + reset provider ──

  it("deletes every MANAGED_SECRET_ENV_KEY from process.env on lock", async () => {
    mockGetSecretVaultStatus.mockReturnValue({ configured: true });
    mockUnlockSecretVault.mockReturnValue({ version: 1, secrets: {} });

    const session = await loadSession();
    await session.unlockSecretSession("correct-password");

    // Simulate the vault-injected runtime: managed secrets present in env.
    process.env.VEX_MASTER_PASSWORD = "should-be-cleared";
    process.env.JUPITER_API_KEY = "jk-should-be-cleared";

    await session.lockSecretSession();

    expect(process.env.VEX_MASTER_PASSWORD).toBeUndefined();
    expect(process.env.JUPITER_API_KEY).toBeUndefined();
  });

  it("invalidates the engine provider cache on lock (resetProvider awaited)", async () => {
    mockGetSecretVaultStatus.mockReturnValue({ configured: true });
    mockUnlockSecretVault.mockReturnValue({ version: 1, secrets: {} });

    const session = await loadSession();
    await session.unlockSecretSession("correct-password");

    await session.lockSecretSession();

    expect(mockResetProvider).toHaveBeenCalledTimes(1);
  });

  it("scrubs managed env keys when getUnlockedSecretPresence's probe fails (defensive relock)", async () => {
    mockGetSecretVaultStatus.mockReturnValue({ configured: true });
    // First unlock returns OK so the session is unlocked; the SECOND unlock
    // (inside the presence probe) throws, forcing the defensive relock path.
    mockUnlockSecretVault
      .mockReturnValueOnce({ version: 1, secrets: {} })
      .mockImplementationOnce(() => {
        throw new LocalSecretVaultErrorMock("corrupt", "corrupt");
      });

    const session = await loadSession();
    await session.unlockSecretSession("correct-password");

    process.env.JUPITER_API_KEY = "jk-should-be-cleared";

    const presence = session.getUnlockedSecretPresence();
    expect(presence.unlocked).toBe(false);
    expect(process.env.JUPITER_API_KEY).toBeUndefined();
  });
});

describe("unlockSecretSession error mapping", () => {
  it("maps LocalSecretVaultError('missing') to wallet.vault_not_configured", async () => {
    mockGetSecretVaultStatus.mockReturnValue({ configured: false });
    mockUnlockSecretVault.mockImplementation(() => {
      throw new LocalSecretVaultErrorMock("vault file missing", "missing");
    });

    const session = await loadSession();
    const result = await session.unlockSecretSession("anypassword");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("wallet.vault_not_configured");
      expect(result.error.retryable).toBe(false);
    }
  });

  it("maps LocalSecretVaultError('invalid_password') to wallet.password_invalid", async () => {
    mockGetSecretVaultStatus.mockReturnValue({ configured: true });
    mockUnlockSecretVault.mockImplementation(() => {
      throw new LocalSecretVaultErrorMock("wrong password", "invalid_password");
    });

    const session = await loadSession();
    const result = await session.unlockSecretSession("wrong");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("wallet.password_invalid");
      expect(result.error.retryable).toBe(true);
    }
  });

  /**
   * Vault unlock error classification: every non-authentication failure —
   * corrupt envelope (pre-decrypt), unreadable contents (post-auth), a
   * too-new outer OR inner version, a crypto-runtime error — must map to
   * codes OTHER than `wallet.password_invalid` — the IPC unlock handler
   * (`ipc/secrets.ts`) advances the unlock throttle ONLY when it sees that
   * exact code, so a distinct code here is what keeps a correct password's
   * downstream failure from ever counting as a failed guess.
   */
  it("maps LocalSecretVaultError('corrupt') to wallet.vault_corrupt (never wallet.password_invalid)", async () => {
    mockGetSecretVaultStatus.mockReturnValue({ configured: true });
    mockUnlockSecretVault.mockImplementation(() => {
      throw new LocalSecretVaultErrorMock("vault contents unreadable", "corrupt");
    });

    const session = await loadSession();
    const result = await session.unlockSecretSession("anypassword");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("wallet.vault_corrupt");
      expect(result.error.code).not.toBe("wallet.password_invalid");
      expect(result.error.retryable).toBe(false);
    }
  });

  it("maps LocalSecretVaultError('incompatible') to wallet.vault_incompatible (never wallet.password_invalid)", async () => {
    mockGetSecretVaultStatus.mockReturnValue({ configured: true });
    mockUnlockSecretVault.mockImplementation(() => {
      throw new LocalSecretVaultErrorMock("vault too new", "incompatible");
    });

    const session = await loadSession();
    const result = await session.unlockSecretSession("anypassword");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("wallet.vault_incompatible");
      expect(result.error.code).not.toBe("wallet.password_invalid");
      expect(result.error.retryable).toBe(false);
    }
  });
});
