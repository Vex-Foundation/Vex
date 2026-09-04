/**
 * Tests for vex.onboarding.wallet* IPC handlers (M8).
 *
 * Mocks electron + runner + restore + password helpers so we exercise
 * the handler glue (envelope, lock wrapping, dialog flow, path
 * validation) without touching real keystores or filesystem.
 */

import path from "node:path";
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

/**
 * `resolveBackupDir` proves containment with `baseReal + path.sep`, so the
 * fixtures below are resolved and joined the same way the real caller's
 * `fs.realpath` results would be. A POSIX literal never carries a drive or a
 * backslash, so on win32 the containment check would refuse every candidate
 * for a reason that has nothing to do with the policy under test.
 */
const BACKUPS = path.resolve("/home/user/.config/vex/backups");

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
  // A getter, because a `vi.mock` factory is hoisted above this file's own
  // bindings and must not read `BACKUPS` at definition time.
  get BACKUPS_DIR(): string {
    return BACKUPS;
  },
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

describe("walletRestoreFromBackup handler", () => {
  it("returns internal.cancelled when user cancels file picker", async () => {
    mockShowOpenDialog.mockResolvedValue({
      canceled: true,
      filePaths: [],
    });
    registerWalletHandlers();
    const fn = handlers.get(CH.onboarding.walletRestoreFromBackup)!;
    const result = (await fn(trustedSender, {
      requestId: "r6",
      payload: { chain: "evm" },
    })) as { ok: boolean; error?: { code: string } };
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("internal.cancelled");
    expect(mockRestore).not.toHaveBeenCalled();
  });

  it("calls restoreWalletFromFile with picked path on success", async () => {
    mockShowOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: ["/tmp/keystore.json"],
    });
    mockRestore.mockResolvedValue({
      ok: true,
      data: {
        chain: "evm",
        address: "0xabcdef0123456789abcdef0123456789abcdef01",
        replacedAddress: null,
        backupDir: null,
      },
    });
    registerWalletHandlers();
    const fn = handlers.get(CH.onboarding.walletRestoreFromBackup)!;
    const result = (await fn(trustedSender, {
      requestId: "r7",
      payload: { chain: "evm" },
    })) as { ok: boolean };
    expect(result.ok).toBe(true);
    expect(mockRestore).toHaveBeenCalledWith(
      expect.objectContaining({
        chain: "evm",
        sourcePath: "/tmp/keystore.json",
        password: "test-password-12",
      })
    );
  });
});

describe("walletOpenBackupFolder handler", () => {
  it("rejects paths outside ${CONFIG_DIR}/backups (realpath-safe)", async () => {
    mockRealpath
      .mockResolvedValueOnce(BACKUPS)
      .mockResolvedValueOnce(path.resolve("/etc/passwd-secret"));
    registerWalletHandlers();
    const fn = handlers.get(CH.onboarding.walletOpenBackupFolder)!;
    const result = (await fn(trustedSender, {
      requestId: "r8",
      payload: { backupDir: path.resolve("/etc/passwd-secret") },
    })) as { ok: boolean; error?: { code: string } };
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("validation.invalid_input");
    expect(mockShellOpenPath).not.toHaveBeenCalled();
  });

  it("opens the path when realpath stays inside the backups base + is a directory", async () => {
    mockRealpath
      .mockResolvedValueOnce(BACKUPS)
      .mockResolvedValueOnce(path.join(BACKUPS, "T123"));
    mockStat.mockResolvedValue({ isDirectory: () => true });
    mockShellOpenPath.mockResolvedValue("");
    registerWalletHandlers();
    const fn = handlers.get(CH.onboarding.walletOpenBackupFolder)!;
    const result = (await fn(trustedSender, {
      requestId: "r9",
      payload: { backupDir: path.join(BACKUPS, "T123") },
    })) as { ok: boolean; data?: { ok: boolean } };
    expect(result.ok).toBe(true);
    expect(result.data?.ok).toBe(true);
    expect(mockShellOpenPath).toHaveBeenCalledWith(path.join(BACKUPS, "T123"));
  });

  it("passes the realpath-resolved candidate to shell.openPath, not the raw input", async () => {
    // User picked a symlinked path; resolved realpath differs but
    // still points inside backups base. Handler MUST hand the
    // resolved path to shell.openPath to avoid the TOCTOU swap.
    mockRealpath
      .mockResolvedValueOnce(BACKUPS)
      .mockResolvedValueOnce(path.join(BACKUPS, "T-real"));
    mockStat.mockResolvedValue({ isDirectory: () => true });
    mockShellOpenPath.mockResolvedValue("");
    registerWalletHandlers();
    const fn = handlers.get(CH.onboarding.walletOpenBackupFolder)!;
    const result = (await fn(trustedSender, {
      requestId: "r10",
      payload: {
        backupDir: path.join(BACKUPS, "symlink-alias"),
      },
    })) as { ok: boolean };
    expect(result.ok).toBe(true);
    expect(mockShellOpenPath).toHaveBeenCalledWith(path.join(BACKUPS, "T-real"));
    expect(mockShellOpenPath).not.toHaveBeenCalledWith(
      path.join(BACKUPS, "symlink-alias")
    );
  });
});

// ── Full-archive restore (C2) ───────────────────────────────────────────────

describe("walletListBackups handler", () => {
  it("returns the metadata array from listAvailableBackups", async () => {
    const backups = [
      {
        id: "2026-05-28T10-00-00-000Z",
        timestamp: "2026-05-28T10:00:00.000Z",
        walletCount: 2,
        addresses: ["0xabc", "SoLaNa1"],
        vaultIncluded: true,
        envIncluded: true,
      },
    ];
    mockListAvailableBackups.mockReturnValue(backups);
    registerWalletHandlers();
    const fn = handlers.get(CH.onboarding.walletListBackups)!;
    const result = (await fn(trustedSender, {
      requestId: "rb1",
      payload: {},
    })) as { ok: boolean; data?: { backups: typeof backups } };
    expect(result.ok).toBe(true);
    expect(result.data?.backups).toEqual(backups);
    expect(mockListAvailableBackups).toHaveBeenCalledTimes(1);
  });
});
