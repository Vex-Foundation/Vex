/**
 * Tests for the vex.secrets.* IPC handlers.
 *
 * Mocks the secrets/session + throttle modules so we exercise the handler
 * glue (envelope, gate, error mapping) without scrypt or filesystem IO.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createTestWebContents,
  createTrustedSender,
  type TestIpcEvent,
} from "./test-sender.js";

type Handler = (
  event: TestIpcEvent,
  raw: unknown,
) => Promise<unknown>;

const handlers = new Map<string, Handler>();

const mockGetSecretSessionStatus = vi.fn();
const mockLockSecretSession = vi.fn();
const mockUnlockSecretSession = vi.fn();
const mockCheckUnlockAllowed = vi.fn();
const mockRecordUnlockFailure = vi.fn();
const mockRecordUnlockSuccess = vi.fn();
const mockShowMessageBox = vi.fn();
const mockWriteVaultResetJournal = vi.fn();
const mockRelaunch = vi.fn();
const mockQuit = vi.fn();

vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, fn: Handler) => {
      handlers.set(channel, fn);
    },
    removeHandler: (channel: string) => {
      handlers.delete(channel);
    },
  },
  app: { isPackaged: true, relaunch: mockRelaunch, quit: mockQuit },
  BrowserWindow: { getFocusedWindow: vi.fn(() => null) },
  dialog: { showMessageBox: (...args: unknown[]) => mockShowMessageBox(...args) },
}));

vi.mock("../../secrets/vault-reset-journal.js", () => ({
  writeVaultResetJournal: (value: unknown) => mockWriteVaultResetJournal(value),
}));

vi.mock("../../secrets/session.js", () => ({
  getSecretSessionStatus: () => mockGetSecretSessionStatus(),
  lockSecretSession: () => mockLockSecretSession(),
  unlockSecretSession: (password: string) => mockUnlockSecretSession(password),
}));

vi.mock("../../secrets/unlock-throttle.js", () => ({
  checkUnlockAllowed: () => mockCheckUnlockAllowed(),
  recordUnlockFailure: () => mockRecordUnlockFailure(),
  recordUnlockSuccess: () => mockRecordUnlockSuccess(),
}));

vi.mock("../../logger/index.js", () => ({
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

const { registerSecretsHandlers, __resetFreshVaultFlightForTests } = await import("../secrets.js");
const { CH } = await import("@shared/ipc/channels.js");

const trustedSender = createTrustedSender({ sender: createTestWebContents() });

beforeEach(() => {
  handlers.clear();
  mockGetSecretSessionStatus.mockReset();
  mockLockSecretSession.mockReset();
  mockUnlockSecretSession.mockReset();
  mockCheckUnlockAllowed.mockReset();
  mockRecordUnlockFailure.mockReset();
  mockRecordUnlockSuccess.mockReset();
  mockShowMessageBox.mockReset();
  mockWriteVaultResetJournal.mockReset();
  mockRelaunch.mockReset();
  mockQuit.mockReset();
  mockLockSecretSession.mockResolvedValue(undefined);
  mockWriteVaultResetJournal.mockResolvedValue(undefined);
  __resetFreshVaultFlightForTests();
});

describe("vex.secrets.resetToFreshVault handler", () => {
  it("requires strict confirm:true input", async () => {
    registerSecretsHandlers();
    const fn = handlers.get(CH.secrets.resetToFreshVault)!;
    for (const payload of [{}, { confirm: false }, { confirm: true, path: "/tmp/x" }]) {
      const result = await fn(trustedSender, { requestId: "bad", payload }) as { ok: boolean };
      expect(result.ok).toBe(false);
    }
    expect(mockShowMessageBox).not.toHaveBeenCalled();
  });

  it("refuses while the secret session is unlocked", async () => {
    mockGetSecretSessionStatus.mockReturnValue({ vaultConfigured: true, unlocked: true });
    registerSecretsHandlers();
    const result = await handlers.get(CH.secrets.resetToFreshVault)!(trustedSender, {
      requestId: "locked-gate",
      payload: { confirm: true },
    }) as { ok: false; error: { code: string } };
    expect(result.error.code).toBe("permissions.denied");
    expect(mockShowMessageBox).not.toHaveBeenCalled();
  });

  it("requires native acknowledgement and includes every abandonment/durability warning", async () => {
    mockGetSecretSessionStatus.mockReturnValue({ vaultConfigured: true, unlocked: false });
    mockShowMessageBox.mockResolvedValue({ response: 1 });
    registerSecretsHandlers();
    const result = await handlers.get(CH.secrets.resetToFreshVault)!(trustedSender, {
      requestId: "cancel",
      payload: { confirm: true },
    }) as { ok: false };
    expect(result.ok).toBe(false);
    // Options are the LAST argument: `showMessageBox(options)` when no window
    // is focused, `showMessageBox(window, options)` otherwise.
    const options = mockShowMessageBox.mock.calls[0]!.at(-1) as { detail: string; defaultId: number; cancelId: number };
    expect(options.detail).toContain("in-progress or persisted mission work");
    expect(options.detail).toContain("pending approvals will simply remain unanswered");
    expect(options.detail).toContain("kept until you delete them from that backup folder");
    expect(options.detail).toContain("encrypted with the forgotten password");
    expect(options.defaultId).toBe(1);
    expect(options.cancelId).toBe(1);
    expect(mockWriteVaultResetJournal).not.toHaveBeenCalled();

    mockShowMessageBox.mockResolvedValue({ response: 0 });
    mockWriteVaultResetJournal.mockRejectedValueOnce(
      new Error("journal unavailable"),
    );
    const retry = await handlers.get(CH.secrets.resetToFreshVault)!(trustedSender, {
      requestId: "retry-after-cancel",
      payload: { confirm: true },
    }) as { ok: boolean };
    expect(retry.ok).toBe(false);
    expect(mockShowMessageBox).toHaveBeenCalledTimes(2);
  });

  it("single-flights journal/relaunch and resolves the response before relaunch", async () => {
    mockGetSecretSessionStatus.mockReturnValue({ vaultConfigured: true, unlocked: false });
    mockShowMessageBox.mockResolvedValue({ response: 0 });
    registerSecretsHandlers();
    const fn = handlers.get(CH.secrets.resetToFreshVault)!;
    const [first, second] = await Promise.all([
      fn(trustedSender, { requestId: "one", payload: { confirm: true } }),
      fn(trustedSender, { requestId: "two", payload: { confirm: true } }),
    ]);
    expect(first).toEqual({ ok: true, data: { scheduled: true } });
    expect(second).toEqual({ ok: true, data: { scheduled: true } });
    expect(mockShowMessageBox).toHaveBeenCalledTimes(1);
    expect(mockLockSecretSession).toHaveBeenCalledTimes(1);
    expect(mockWriteVaultResetJournal).toHaveBeenCalledTimes(1);
    expect(mockRelaunch).not.toHaveBeenCalled();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(mockRelaunch).toHaveBeenCalledTimes(1);
    expect(mockQuit).toHaveBeenCalledTimes(1);
  });
});

afterEach(() => {
  handlers.clear();
  vi.clearAllMocks();
});

describe("vex.secrets.status handler", () => {
  it("returns the status snapshot from the session module", async () => {
    mockGetSecretSessionStatus.mockReturnValue({
      vaultConfigured: true,
      unlocked: false,
    });
    registerSecretsHandlers();

    const fn = handlers.get(CH.secrets.status)!;
    const result = (await fn(trustedSender, {
      requestId: "r1",
      payload: {},
    })) as { ok: boolean; data?: { vaultConfigured: boolean; unlocked: boolean } };
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ vaultConfigured: true, unlocked: false });
  });
});

describe("vex.secrets.lock handler", () => {
  it("invokes lockSecretSession and returns {locked:true}", async () => {
    registerSecretsHandlers();
    const fn = handlers.get(CH.secrets.lock)!;
    const result = (await fn(trustedSender, {
      requestId: "r-lock",
      payload: {},
    })) as { ok: boolean; data?: { locked: boolean } };
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ locked: true });
    expect(mockLockSecretSession).toHaveBeenCalledTimes(1);
  });
});

describe("vex.secrets.unlock handler - throttle gate", () => {
  it("returns secrets.unlock_throttled when gate denies the attempt", async () => {
    mockCheckUnlockAllowed.mockReturnValue({
      allowed: false,
      retryAfterMs: 4_000,
    });
    registerSecretsHandlers();

    const fn = handlers.get(CH.secrets.unlock)!;
    const result = (await fn(trustedSender, {
      requestId: "throttled-1",
      payload: { password: "anypassword123" },
    })) as {
      ok: false;
      error: {
        code: string;
        retryAfterMs?: number;
        message: string;
        correlationId?: string;
        retryable: boolean;
        domain: string;
      };
    };
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("secrets.unlock_throttled");
    expect(result.error.retryAfterMs).toBe(4_000);
    expect(result.error.domain).toBe("wallet");
    expect(result.error.retryable).toBe(true);
    expect(result.error.correlationId).toBe("throttled-1");
    // session.unlock must NOT be invoked while the gate is closed.
    expect(mockUnlockSecretSession).not.toHaveBeenCalled();
    expect(mockRecordUnlockFailure).not.toHaveBeenCalled();
  });

  it("formats retryAfterMs to seconds in the message (under 60s)", async () => {
    mockCheckUnlockAllowed.mockReturnValue({
      allowed: false,
      retryAfterMs: 8_000,
    });
    registerSecretsHandlers();

    const fn = handlers.get(CH.secrets.unlock)!;
    const result = (await fn(trustedSender, {
      requestId: "r",
      payload: { password: "anypassword123" },
    })) as { ok: false; error: { message: string } };
    expect(result.error.message).toContain("8s");
  });

  it("formats retryAfterMs to minutes for >=60s lockout", async () => {
    mockCheckUnlockAllowed.mockReturnValue({
      allowed: false,
      retryAfterMs: 300_000,
    });
    registerSecretsHandlers();

    const fn = handlers.get(CH.secrets.unlock)!;
    const result = (await fn(trustedSender, {
      requestId: "r",
      payload: { password: "anypassword123" },
    })) as { ok: false; error: { message: string } };
    expect(result.error.message).toMatch(/\d+m/);
  });
});

describe("vex.secrets.unlock handler - session interaction", () => {
  it("on success: records success + does NOT record failure", async () => {
    mockCheckUnlockAllowed.mockReturnValue({ allowed: true });
    mockUnlockSecretSession.mockReturnValue({
      ok: true,
      data: { unlocked: true },
    });
    registerSecretsHandlers();

    const fn = handlers.get(CH.secrets.unlock)!;
    const result = (await fn(trustedSender, {
      requestId: "ok-1",
      payload: { password: "correct-password" },
    })) as { ok: boolean };
    expect(result.ok).toBe(true);
    expect(mockRecordUnlockSuccess).toHaveBeenCalledTimes(1);
    expect(mockRecordUnlockFailure).not.toHaveBeenCalled();
  });

  it("on wrong-password failure: records failure + propagates error", async () => {
    mockCheckUnlockAllowed.mockReturnValue({ allowed: true });
    mockUnlockSecretSession.mockReturnValue({
      ok: false,
      error: {
        code: "wallet.password_invalid",
        domain: "wallet",
        message: "Master password is incorrect.",
        retryable: true,
        userActionable: true,
        redacted: true,
      },
    });
    registerSecretsHandlers();

    const fn = handlers.get(CH.secrets.unlock)!;
    const result = (await fn(trustedSender, {
      requestId: "wp-1",
      payload: { password: "wrong-password" },
    })) as { ok: false; error: { code: string } };
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("wallet.password_invalid");
    expect(mockRecordUnlockFailure).toHaveBeenCalledTimes(1);
    expect(mockRecordUnlockSuccess).not.toHaveBeenCalled();
  });

  it("on non-password failure (IO/corrupt): does NOT bump throttle counter", async () => {
    mockCheckUnlockAllowed.mockReturnValue({ allowed: true });
    mockUnlockSecretSession.mockReturnValue({
      ok: false,
      error: {
        code: "onboarding.env_persist_failed",
        domain: "onboarding",
        message: "Could not access the encrypted secret vault.",
        retryable: true,
        userActionable: true,
        redacted: true,
      },
    });
    registerSecretsHandlers();

    const fn = handlers.get(CH.secrets.unlock)!;
    const result = (await fn(trustedSender, {
      requestId: "io-1",
      payload: { password: "anypassword123" },
    })) as { ok: false; error: { code: string } };
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("onboarding.env_persist_failed");
    expect(mockRecordUnlockFailure).not.toHaveBeenCalled();
    expect(mockRecordUnlockSuccess).not.toHaveBeenCalled();
  });

  it("on missing-vault failure: does NOT bump throttle counter", async () => {
    mockCheckUnlockAllowed.mockReturnValue({ allowed: true });
    mockUnlockSecretSession.mockReturnValue({
      ok: false,
      error: {
        code: "wallet.vault_not_configured",
        domain: "wallet",
        message: "Master password is not configured. Complete setup first.",
        retryable: false,
        userActionable: true,
        redacted: true,
      },
    });
    registerSecretsHandlers();

    const fn = handlers.get(CH.secrets.unlock)!;
    const result = (await fn(trustedSender, {
      requestId: "missing-1",
      payload: { password: "anypassword123" },
    })) as { ok: false; error: { code: string } };
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("wallet.vault_not_configured");
    expect(mockRecordUnlockFailure).not.toHaveBeenCalled();
    expect(mockRecordUnlockSuccess).not.toHaveBeenCalled();
  });
});
