/**
 * Tests for the vex.wallet.exportPrivateKey IPC handler.
 *
 * Mocks: electron (ipcMain + clipboard), secrets/session, export-throttle,
 * verifySecretVaultPassword, the engine wallet inventory + export helper
 * (`getWalletById` + `decryptExportSecret`), lifecycle/cleanup registry, and
 * the logger. The clipboard-lease module is intentionally NOT mocked — it runs
 * for real against the mocked electron clipboard + cleanup registry so the
 * lease lifecycle (timer, conditional clear, quit cleanup) is exercised
 * end-to-end. Exercises the full handler control flow without touching real
 * keystores, the vault file, or the actual OS clipboard.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createTestWebContents,
  createTrustedSender,
  type TestIpcEvent,
} from "../test-sender.js";

type Handler = (
  event: TestIpcEvent,
  raw: unknown,
) => Promise<unknown>;

const handlers = new Map<string, Handler>();

// ── clipboard mock ─────────────────────────────────────────────────────────
let clipboardText = "";
const mockClipboardWriteText = vi.fn((text: string) => {
  clipboardText = text;
});
const mockClipboardReadText = vi.fn(() => clipboardText);
const mockClipboardClear = vi.fn(() => {
  clipboardText = "";
});

// ── session mocks ─────────────────────────────────────────────────────────
const mockGetSecretSessionStatus = vi.fn();
const mockLockSecretSession = vi.fn();

// ── throttle mocks ────────────────────────────────────────────────────────
const mockCheckExportAllowed = vi.fn();
const mockRecordExportFailure = vi.fn();
const mockRecordExportSuccess = vi.fn();

// ── vault verify mock ─────────────────────────────────────────────────────
const mockVerifySecretVaultPassword = vi.fn();

// LocalSecretVaultError clone (matches engine's surface used by handler).
class LocalSecretVaultErrorMock extends Error {
  constructor(
    message: string,
    readonly code: "missing" | "invalid_password" | "corrupt" | "io",
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "LocalSecretVaultError";
  }
}

// ── engine inventory + export-helper mocks ─────────────────────────────────
// The handler resolves the wallet by id (`getWalletById`) then decrypts +
// verifies it in the engine (`decryptExportSecret`). Both are mocked so the
// handler's control flow is tested in isolation from real keystores.
const mockGetWalletById = vi.fn();
const mockDecryptExportSecret = vi.fn();

// VexError clone surfaced by the engine export helper on decrypt/verify failure.
class FakeEngineVexError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "VexError";
  }
}

// ── cleanup registry mock ─────────────────────────────────────────────────
// Match the surface used: add(task) returns an unregister fn (async).
// Track active tasks so tests can simulate "app quit fires cleanup".
type CleanupTask = () => void | Promise<void>;
const cleanupTasks = new Set<CleanupTask>();
const mockGlobalCleanupAdd = vi.fn((task: CleanupTask) => {
  cleanupTasks.add(task);
  return async (): Promise<void> => {
    cleanupTasks.delete(task);
    await task();
  };
});

function runAllCleanup(): Promise<void> {
  const snapshot = [...cleanupTasks];
  cleanupTasks.clear();
  return Promise.allSettled(snapshot.map((t) => t())).then(() => undefined);
}

// ── module mocks ──────────────────────────────────────────────────────────
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
  clipboard: {
    writeText: (text: string) => mockClipboardWriteText(text),
    readText: () => mockClipboardReadText(),
    clear: () => mockClipboardClear(),
  },
}));

vi.mock("../../../secrets/session.js", () => ({
  getSecretSessionStatus: () => mockGetSecretSessionStatus(),
  lockSecretSession: () => mockLockSecretSession(),
}));

vi.mock("../../../wallet/export-throttle.js", () => ({
  checkExportAllowed: () => mockCheckExportAllowed(),
  recordExportFailure: () => mockRecordExportFailure(),
  recordExportSuccess: () => mockRecordExportSuccess(),
}));

vi.mock("@vex-lib/local-secret-vault.js", () => ({
  LocalSecretVaultError: LocalSecretVaultErrorMock,
  verifySecretVaultPassword: (...args: unknown[]) =>
    mockVerifySecretVaultPassword(...args),
}));

vi.mock("@vex-lib/wallet.js", () => ({
  getWalletById: (family: unknown, id: unknown) =>
    mockGetWalletById(family, id),
  decryptExportSecret: (args: unknown) => mockDecryptExportSecret(args),
}));

vi.mock("../../../paths/config-dir.js", () => ({
  SECRETS_VAULT_FILE: "/tmp/vex-test-vault",
}));

vi.mock("../../../lifecycle/cleanup-registry.js", () => ({
  globalCleanup: {
    add: (task: CleanupTask) => mockGlobalCleanupAdd(task),
  },
}));

const mockLog = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

vi.mock("../../../logger/index.js", () => ({
  log: mockLog,
}));

const {
  registerWalletExportHandler,
  __resetWalletExportStateForTests,
  __getActiveLeaseTokenForTests,
} = await import("../../wallet-export.js");
const { CH } = await import("@shared/ipc/channels.js");
const { walletExportPrivateKeyInputSchema } = await import(
  "@shared/schemas/wallets.js"
);

const trustedSender = createTrustedSender({ sender: createTestWebContents() });

const WALLET_ID_EVM = "evm_11111111-1111-1111-1111-111111111111";
const WALLET_ID_SOLANA = "sol_22222222-2222-2222-2222-222222222222";

const VALID_INPUT_EVM = {
  chain: "evm",
  walletId: WALLET_ID_EVM,
  password: "master-password-12",
  riskAcknowledged: true,
} as const;

const VALID_INPUT_SOLANA = {
  chain: "solana",
  walletId: WALLET_ID_SOLANA,
  password: "master-password-12",
  riskAcknowledged: true,
} as const;

// Inventory entry returned by `getWalletById`. The handler only checks for
// non-null and forwards it to the (mocked) decrypt helper + logs the id from
// the input, so a minimal shape is sufficient here. The real entry shape is
// exercised in the engine `inventory.test.ts`.
const STUB_ENTRY_EVM = {
  id: WALLET_ID_EVM,
  address: "0x1234567890abcdef1234567890abcdef12345678",
  label: "EVM 1",
  createdAt: "2026-01-01T00:00:00.000Z",
};

const STUB_ENTRY_SOLANA = {
  id: WALLET_ID_SOLANA,
  address: "So11111111111111111111111111111111111111112",
  label: "Solana 1",
  createdAt: "2026-01-01T00:00:00.000Z",
};

beforeEach(() => {
  vi.useFakeTimers();
  clipboardText = "";
  handlers.clear();
  cleanupTasks.clear();
  mockClipboardWriteText.mockClear();
  mockClipboardReadText.mockClear();
  mockClipboardClear.mockClear();
  mockGetSecretSessionStatus.mockReset();
  mockLockSecretSession.mockReset();
  mockCheckExportAllowed.mockReset();
  mockRecordExportFailure.mockReset();
  mockRecordExportSuccess.mockReset();
  mockVerifySecretVaultPassword.mockReset();
  mockGetWalletById.mockReset();
  mockDecryptExportSecret.mockReset();
  mockGlobalCleanupAdd.mockClear();
  mockLog.info.mockClear();
  mockLog.warn.mockClear();
  mockLog.error.mockClear();
  mockLog.debug.mockClear();
  __resetWalletExportStateForTests();
});

afterEach(() => {
  __resetWalletExportStateForTests();
  handlers.clear();
  cleanupTasks.clear();
  vi.useRealTimers();
  vi.clearAllMocks();
});

function getHandler(): Handler {
  registerWalletExportHandler();
  const fn = handlers.get(CH.wallet.exportPrivateKey);
  if (!fn) throw new Error("handler not registered");
  return fn;
}

interface ErrResult {
  readonly ok: false;
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly retryAfterMs?: number;
    readonly correlationId?: string;
    readonly domain: string;
    readonly retryable: boolean;
    readonly userActionable: boolean;
  };
}

interface OkResult<T> {
  readonly ok: true;
  readonly data: T;
}

interface ExportOk {
  chain: string;
  format: string;
  copied: boolean;
  clearAfterMs: number;
}

// ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ──

// ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ──

describe("success path - Solana", () => {
  beforeEach(() => {
    mockCheckExportAllowed.mockReturnValue({ allowed: true });
    mockGetSecretSessionStatus.mockReturnValue({
      vaultConfigured: true,
      unlocked: true,
    });
    mockVerifySecretVaultPassword.mockReturnValue(undefined);
    mockGetWalletById.mockReturnValue(STUB_ENTRY_SOLANA);
  });

  it("writes the base58 secret to clipboard and returns the expected shape", async () => {
    // The engine helper owns Solana plaintext-buffer zeroization (covered in
    // src/__tests__/wallet/inventory.test.ts); the handler only sees the
    // already-encoded base58 string.
    const BASE58 = "fakebase58encodedsecret1234567890";
    mockDecryptExportSecret.mockReturnValue({ secret: BASE58, format: "base58" });
    const fn = getHandler();

    const result = (await fn(trustedSender, {
      requestId: "ok-sol",
      payload: VALID_INPUT_SOLANA,
    })) as OkResult<ExportOk>;

    expect(result.ok).toBe(true);
    expect(result.data.chain).toBe("solana");
    expect(result.data.format).toBe("base58");
    expect(mockDecryptExportSecret).toHaveBeenCalledWith({
      family: "solana",
      entry: STUB_ENTRY_SOLANA,
      password: "master-password-12",
    });
    expect(mockClipboardWriteText).toHaveBeenCalledWith(BASE58);
  });
});
