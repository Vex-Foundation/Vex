/**
 * Tests for vex.onboarding.wallet* IPC handlers (M8).
 *
 * Mocks electron + runner + restore + password helpers so we exercise
 * the handler glue (envelope, lock wrapping, dialog flow, path
 * validation) without touching real keystores or filesystem.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createTestWebContents,
  createTrustedSender,
  type TestIpcEvent,
} from "../../../__tests__/test-sender.js";

type Handler = (
  event: TestIpcEvent,
  raw: unknown
) => Promise<unknown>;

const handlers = new Map<string, Handler>();

const mockGenerateEvm = vi.fn();
const mockGenerateSolana = vi.fn();
const mockImportEvm = vi.fn();
const mockImportSolana = vi.fn();
const mockRestore = vi.fn();
const mockAddEvm = vi.fn();
const mockAddSolana = vi.fn();
const mockImportAddEvm = vi.fn();
const mockImportAddSolana = vi.fn();
const mockExportAll = vi.fn();
const mockShowOpenDialog = vi.fn();
const mockShowMessageBox = vi.fn();
const mockShellOpenPath = vi.fn();
const mockBrowserWindowFromWebContents = vi.fn();
const mockRealpath = vi.fn();
const mockStat = vi.fn();
// C2 — full-archive restore mocks.
const mockListAvailableBackups = vi.fn();
const mockRestoreFromBackupArchive = vi.fn();
const mockApplySecretVaultToProcessEnv = vi.fn();
const mockLoadProviderDotenv = vi.fn();
const mockResetProvider = vi.fn();
const mockLockSecretSession = vi.fn();
const mockAdoptUnlockedPassword = vi.fn();

/**
 * Recording logger: real-shaped log surface that captures every formatted
 * string so a test can assert the password never appears in any log line.
 */
const loggedStrings: string[] = [];
function recordLog(...args: unknown[]): void {
  loggedStrings.push(args.map((a) => String(a)).join(" "));
}

vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, fn: Handler) => {
      handlers.set(channel, fn);
    },
    removeHandler: (channel: string) => {
      handlers.delete(channel);
    },
  },
  app: { isPackaged: true },
  BrowserWindow: {
    fromWebContents: (sender: unknown) => mockBrowserWindowFromWebContents(sender),
  },
  dialog: {
    showOpenDialog: (parent: unknown, opts: unknown) =>
      mockShowOpenDialog(parent, opts),
    showMessageBox: (parent: unknown, opts: unknown) =>
      mockShowMessageBox(parent, opts),
  },
  shell: {
    openPath: (path: string) => mockShellOpenPath(path),
  },
}));

vi.mock("@vex-lib/wallet.js", () => ({
  BACKUPS_DIR: "/home/user/.config/vex/backups",
  listAvailableBackups: () => mockListAvailableBackups(),
  restoreFromBackupArchive: (args: unknown) => mockRestoreFromBackupArchive(args),
}));

vi.mock("@vex-lib/local-secret-vault.js", () => ({
  applySecretVaultToProcessEnv: (password: string, options: unknown) =>
    mockApplySecretVaultToProcessEnv(password, options),
}));

vi.mock("@vex-lib/runtime-env.js", () => ({
  loadProviderDotenv: (options: unknown) => mockLoadProviderDotenv(options),
}));

vi.mock("@vex-agent/inference/registry.js", () => ({
  resetProvider: () => mockResetProvider(),
}));

vi.mock("../../../../secrets/session.js", () => ({
  lockSecretSession: async () => mockLockSecretSession(),
  adoptUnlockedPassword: (password: string) =>
    mockAdoptUnlockedPassword(password),
}));

vi.mock("../../../../paths/config-dir.js", () => ({
  SECRETS_VAULT_FILE: "/home/user/.config/vex/secrets.vault.json",
}));

/**
 * Minimal stand-in for the real `mapWalletEngineError`: maps the engine
 * VexError codes the C2 tests exercise to their public IPC codes. Mirrors the
 * real switch for the tested subset so a regression in the handler's wiring
 * still surfaces here.
 */
function mapEngineCode(cause: unknown): unknown {
  const code =
    typeof cause === "object" && cause !== null && "code" in cause
      ? (cause as { code: unknown }).code
      : undefined;
  const ipcCode =
    code === "SIGNER_MISMATCH"
      ? "wallet.signer_mismatch"
      : code === "KEYSTORE_DECRYPT_FAILED"
        ? "wallet.password_invalid"
        : code === "ARCHIVE_INCOMPLETE"
          ? "validation.archive_incomplete"
          : code === "ARCHIVE_MANIFEST_MALFORMED"
            ? "validation.archive_manifest_malformed"
            : "internal.unexpected";
  return {
    ok: false,
    error: {
      code: ipcCode,
      domain: ipcCode.startsWith("wallet.") ? "wallet" : "onboarding",
      message: "mapped",
      retryable: false,
      userActionable: true,
      redacted: true,
    },
  };
}

vi.mock("../../../../onboarding/wallets-runner.js", () => ({
  generateEvmWallet: () => mockGenerateEvm(),
  generateSolanaWallet: () => mockGenerateSolana(),
  importEvmWallet: (rawKey: string) => mockImportEvm(rawKey),
  importSolanaWalletRunner: (rawKey: string) => mockImportSolana(rawKey),
  addEvmWallet: (label?: string) => mockAddEvm(label),
  addSolanaWallet: (label?: string) => mockAddSolana(label),
  importEvmWalletInventory: (rawKey: string, label?: string) =>
    mockImportAddEvm(rawKey, label),
  importSolanaWalletInventory: (rawKey: string, label?: string) =>
    mockImportAddSolana(rawKey, label),
  exportAllWalletsRunner: (destDir: string) => mockExportAll(destDir),
  mapWalletEngineError: (cause: unknown) => mapEngineCode(cause),
}));

vi.mock("../../../../onboarding/wallet-restore.js", () => ({
  restoreWalletFromFile: (args: unknown) => mockRestore(args),
}));

vi.mock("../../../../onboarding/wallet-password.js", () => ({
  withFreshKeystorePassword: async <T>(
    fn: (ctx: { password: string }) => Promise<T>
  ): Promise<T> => fn({ password: "test-password-12" }),
  isPasswordSetupError: (v: unknown) =>
    typeof v === "object" &&
    v !== null &&
    "ok" in v &&
    (v as { ok: unknown }).ok === false,
}));

vi.mock("../../../../onboarding/wallet-mutex.js", () => ({
  withWalletLock: <T>(fn: () => Promise<T>) => fn(),
}));

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    promises: {
      ...actual.promises,
      realpath: (p: string) => mockRealpath(p),
      stat: (p: string) => mockStat(p),
    },
  };
});

vi.mock("../../../../logger/index.js", () => ({
  log: {
    info: (...args: unknown[]) => recordLog(...args),
    warn: (...args: unknown[]) => recordLog(...args),
    error: (...args: unknown[]) => recordLog(...args),
    debug: (...args: unknown[]) => recordLog(...args),
  },
}));

const { registerWalletHandlers } = await import("../../wallets.js");
const { CH } = await import("@shared/ipc/channels.js");
const {
  walletRestoreArchiveInputSchema,
  walletRestoreArchiveResultSchema,
} = await import("@shared/schemas/wallets.js");

const trustedSender = createTrustedSender({ sender: createTestWebContents() });

beforeEach(() => {
  handlers.clear();
  mockGenerateEvm.mockReset();
  mockGenerateSolana.mockReset();
  mockImportEvm.mockReset();
  mockImportSolana.mockReset();
  mockRestore.mockReset();
  mockAddEvm.mockReset();
  mockAddSolana.mockReset();
  mockImportAddEvm.mockReset();
  mockImportAddSolana.mockReset();
  mockExportAll.mockReset();
  mockShowOpenDialog.mockReset();
  mockShowMessageBox.mockReset();
  mockShellOpenPath.mockReset();
  mockBrowserWindowFromWebContents.mockReturnValue(null);
  mockRealpath.mockReset();
  mockStat.mockReset();
  mockListAvailableBackups.mockReset();
  mockRestoreFromBackupArchive.mockReset();
  mockApplySecretVaultToProcessEnv.mockReset();
  mockLoadProviderDotenv.mockReset();
  mockResetProvider.mockReset();
  mockLockSecretSession.mockReset();
  mockAdoptUnlockedPassword.mockReset();
  loggedStrings.length = 0;
});

afterEach(() => {
  handlers.clear();
  vi.clearAllMocks();
});

describe("walletRestoreArchive handler", () => {
  const happyArchive = {
    filesRestored: ["wallet-evm_legacy.json", "secrets.vault.json", ".env"],
    walletsRestored: [
      {
        id: "evm_legacy",
        address: "0xabcdef0123456789abcdef0123456789abcdef01",
        label: "EVM",
        createdAt: "2026-05-28T10:00:00.000Z",
        legacy: true,
      },
    ],
    backupDir: "/home/user/.config/vex/backups/2026-05-28T10-00-00-000Z",
    vaultRestored: true,
    vaultLocked: false,
  };

  it("happy path returns {filesRestored, walletsRestored, vaultLocked:false} and never leaks backupDir", async () => {
    mockRestoreFromBackupArchive.mockResolvedValue(happyArchive);
    registerWalletHandlers();
    const fn = handlers.get(CH.onboarding.walletRestoreArchive)!;
    const result = (await fn(trustedSender, {
      requestId: "rb2",
      payload: { id: "2026-05-28T10-00-00-000Z", password: "test-password-12" },
    })) as {
      ok: boolean;
      data?: Record<string, unknown>;
    };
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({
      filesRestored: happyArchive.filesRestored,
      walletsRestored: happyArchive.walletsRestored,
      vaultLocked: false,
    });
    // backupDir is a metadata-only-boundary violation — must NOT cross IPC.
    expect(result.data).not.toHaveProperty("backupDir");
    // archiveDir is joined under BACKUPS_DIR from the opaque id.
    expect(mockRestoreFromBackupArchive).toHaveBeenCalledWith(
      expect.objectContaining({
        archiveDir:
          "/home/user/.config/vex/backups/2026-05-28T10-00-00-000Z",
        password: "test-password-12",
      })
    );
  });

  it("vaultLocked:false path refreshes runtime (apply + loadProviderDotenv overwrite + resetProvider) once, no lock", async () => {
    mockRestoreFromBackupArchive.mockResolvedValue(happyArchive);
    registerWalletHandlers();
    const fn = handlers.get(CH.onboarding.walletRestoreArchive)!;
    await fn(trustedSender, {
      requestId: "rb3",
      payload: { id: "abc", password: "test-password-12" },
    });
    expect(mockApplySecretVaultToProcessEnv).toHaveBeenCalledTimes(1);
    expect(mockApplySecretVaultToProcessEnv).toHaveBeenCalledWith(
      "test-password-12",
      { filePath: "/home/user/.config/vex/secrets.vault.json" }
    );
    expect(mockAdoptUnlockedPassword).toHaveBeenCalledWith("test-password-12");
    expect(mockLoadProviderDotenv).toHaveBeenCalledWith({ overwrite: true });
    expect(mockResetProvider).toHaveBeenCalledTimes(1);
    expect(mockLockSecretSession).not.toHaveBeenCalled();
  });

  it("vaultLocked:true path scrubs via lockSecretSession instead of applying the supplied password", async () => {
    mockRestoreFromBackupArchive.mockResolvedValue({
      ...happyArchive,
      vaultLocked: true,
    });
    registerWalletHandlers();
    const fn = handlers.get(CH.onboarding.walletRestoreArchive)!;
    const result = (await fn(trustedSender, {
      requestId: "rb4",
      payload: { id: "abc", password: "test-password-12" },
    })) as { ok: boolean; data?: { vaultLocked: boolean } };
    expect(result.ok).toBe(true);
    expect(result.data?.vaultLocked).toBe(true);
    expect(mockLockSecretSession).toHaveBeenCalledTimes(1);
    expect(mockApplySecretVaultToProcessEnv).not.toHaveBeenCalled();
    expect(mockAdoptUnlockedPassword).not.toHaveBeenCalled();
    // .env + provider refresh ALWAYS runs, both branches.
    expect(mockLoadProviderDotenv).toHaveBeenCalledWith({ overwrite: true });
    expect(mockResetProvider).toHaveBeenCalledTimes(1);
  });

  it("no-vault restore: skips vault apply/adopt/scrub (vaultLocked:false is ambiguous) but still refreshes provider env/cache", async () => {
    // Archive carried NO vault → filesRestored has no secrets.vault.json, and
    // C1 returns vaultLocked:false. The handler must NOT apply the supplied
    // password against the current/missing vault just because vaultLocked is
    // false; it must leave vault/session untouched and still refresh .env+provider.
    mockRestoreFromBackupArchive.mockResolvedValue({
      ...happyArchive,
      filesRestored: ["wallet-evm_legacy.json", ".env"],
      vaultRestored: false,
      vaultLocked: false,
    });
    registerWalletHandlers();
    const fn = handlers.get(CH.onboarding.walletRestoreArchive)!;
    const result = (await fn(trustedSender, {
      requestId: "rb5",
      payload: { id: "abc", password: "test-password-12" },
    })) as { ok: boolean };
    expect(result.ok).toBe(true);
    expect(mockApplySecretVaultToProcessEnv).not.toHaveBeenCalled();
    expect(mockAdoptUnlockedPassword).not.toHaveBeenCalled();
    expect(mockLockSecretSession).not.toHaveBeenCalled();
    // .env + provider refresh ALWAYS runs regardless of vault presence.
    expect(mockLoadProviderDotenv).toHaveBeenCalledWith({ overwrite: true });
    expect(mockResetProvider).toHaveBeenCalledTimes(1);
  });

  it("maps a thrown SIGNER_MISMATCH to ok:false code wallet.signer_mismatch (no runtime refresh)", async () => {
    mockRestoreFromBackupArchive.mockRejectedValue({ code: "SIGNER_MISMATCH" });
    registerWalletHandlers();
    const fn = handlers.get(CH.onboarding.walletRestoreArchive)!;
    const result = (await fn(trustedSender, {
      requestId: "rb5",
      payload: { id: "abc", password: "test-password-12" },
    })) as { ok: boolean; error?: { code: string } };
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("wallet.signer_mismatch");
    expect(mockApplySecretVaultToProcessEnv).not.toHaveBeenCalled();
    expect(mockLockSecretSession).not.toHaveBeenCalled();
    expect(mockResetProvider).not.toHaveBeenCalled();
  });

  it("maps a thrown KEYSTORE_DECRYPT_FAILED to wallet.password_invalid", async () => {
    mockRestoreFromBackupArchive.mockRejectedValue({
      code: "KEYSTORE_DECRYPT_FAILED",
    });
    registerWalletHandlers();
    const fn = handlers.get(CH.onboarding.walletRestoreArchive)!;
    const result = (await fn(trustedSender, {
      requestId: "rb6",
      payload: { id: "abc", password: "test-password-12" },
    })) as { ok: boolean; error?: { code: string } };
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("wallet.password_invalid");
  });

  it("maps a thrown ARCHIVE_INCOMPLETE to validation.archive_incomplete", async () => {
    mockRestoreFromBackupArchive.mockRejectedValue({
      code: "ARCHIVE_INCOMPLETE",
    });
    registerWalletHandlers();
    const fn = handlers.get(CH.onboarding.walletRestoreArchive)!;
    const result = (await fn(trustedSender, {
      requestId: "rb7",
      payload: { id: "abc", password: "test-password-12" },
    })) as { ok: boolean; error?: { code: string } };
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("validation.archive_incomplete");
  });

  it("never writes the password into any log line (happy path)", async () => {
    mockRestoreFromBackupArchive.mockResolvedValue(happyArchive);
    registerWalletHandlers();
    const fn = handlers.get(CH.onboarding.walletRestoreArchive)!;
    const secret = "super-secret-master-pw";
    await fn(trustedSender, {
      requestId: "rb8",
      payload: { id: "abc", password: secret },
    });
    expect(loggedStrings.length).toBeGreaterThan(0);
    for (const line of loggedStrings) {
      expect(line).not.toContain(secret);
    }
  });
});

describe("walletRestoreArchive schema validation", () => {
  it("accepts a valid {id, password}", () => {
    const parsed = walletRestoreArchiveInputSchema.safeParse({
      id: "2026-05-28T10-00-00-000Z",
      password: "p",
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects an empty id", () => {
    expect(
      walletRestoreArchiveInputSchema.safeParse({ id: "", password: "p" })
        .success
    ).toBe(false);
  });

  it("rejects an empty password", () => {
    expect(
      walletRestoreArchiveInputSchema.safeParse({ id: "x", password: "" })
        .success
    ).toBe(false);
  });

  it("rejects unknown keys (strict) - e.g. a smuggled absolute path", () => {
    expect(
      walletRestoreArchiveInputSchema.safeParse({
        id: "x",
        password: "p",
        archiveDir: "/etc/passwd",
      }).success
    ).toBe(false);
  });

  it("result schema accepts the secret-free shape and rejects a leaked backupDir", () => {
    const valid = walletRestoreArchiveResultSchema.safeParse({
      filesRestored: ["a.json"],
      walletsRestored: [
        {
          id: "evm_legacy",
          address: "0xabc",
          label: "EVM",
          createdAt: "2026-05-28T10:00:00.000Z",
          legacy: true,
        },
      ],
      vaultLocked: false,
    });
    expect(valid.success).toBe(true);

    const leaked = walletRestoreArchiveResultSchema.safeParse({
      filesRestored: [],
      walletsRestored: [],
      vaultLocked: false,
      backupDir: "/home/user/.config/vex/backups/x",
    });
    expect(leaked.success).toBe(false);
  });
});
