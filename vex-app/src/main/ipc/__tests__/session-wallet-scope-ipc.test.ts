/**
 * Session wallet-scope IPC handlers.
 *
 * Focused contract for the two handlers that expose per-session wallet
 * selection. The DB-layer CAS + missions.allowed_wallets recompute is pinned
 * in `database/__tests__/sessions-wallet-scope.test.ts`, and the id→ref
 * resolution + fail-closed error in `wallet-refs.test.ts`. This file pins the
 * handler seam between them:
 *   - listSessionWallets: DB scope row → {sessionId, evm, solana} DTO
 *     (address from the scope row, label from the inventory entry).
 *   - setSessionWalletScope: resolve ids server-side, fail closed on an
 *     unknown id BEFORE any DB write, otherwise persist via the CAS.
 *
 * We mock `getWalletById` (inventory boundary) but keep the REAL
 * `resolveWalletRef` + `invalidWalletSelectionError` so the actual
 * handler→resolver→inventory path is exercised.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createTestWebContents,
  createTrustedSender,
  type TestIpcEvent,
} from "./test-sender.js";

type Handler = (event: TestIpcEvent, raw: unknown) => Promise<unknown>;

const handlers = vi.hoisted(() => new Map<string, Handler>());
const mocks = vi.hoisted(() => ({
  getSessionWalletScope: vi.fn(),
  initializeSessionWalletScope: vi.fn(),
  getWalletById: vi.fn(),
  listWallets: vi.fn(() => []),
  ensureEngineDbUrl: vi.fn().mockResolvedValue({ ok: true, data: undefined }),
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

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
}));

vi.mock("../../database/sessions-db.js", () => ({
  getSessionWalletScope: (...a: unknown[]) => mocks.getSessionWalletScope(...a),
  initializeSessionWalletScope: (...a: unknown[]) =>
    mocks.initializeSessionWalletScope(...a),
}));

// Mock the inventory boundary only — the real `resolveWalletRef` +
// `invalidWalletSelectionError` run on top of this.
vi.mock("@vex-lib/wallet.js", () => ({
  getWalletById: (...a: unknown[]) => mocks.getWalletById(...a),
  listWallets: (...a: unknown[]) => mocks.listWallets(...a),
}));

vi.mock("../../database/engine-db-readiness.js", () => ({
  ensureEngineDbUrl: (...a: unknown[]) => mocks.ensureEngineDbUrl(...a),
}));

vi.mock("../../logger/index.js", () => ({
  log: mocks.log,
}));

const { CH } = await import("../../../shared/ipc/channels.js");
const { registerWalletsSessionHandlers } = await import("../wallets-session.js");

// ── Test scaffolding ────────────────────────────────────────────────────

const SESSION = "00000000-0000-4000-8000-000000000001";
const trustedSender = createTrustedSender({ sender: createTestWebContents() });

let cleanups: ReadonlyArray<() => void> | null = null;

function setupHandlers(): void {
  handlers.clear();
  cleanups = registerWalletsSessionHandlers();
}

async function call<T = unknown>(
  channel: string,
  payload: Record<string, unknown>,
  options: { requestId?: string } = {},
): Promise<{
  ok: boolean;
  data?: T;
  error?: { code: string; message: string; details?: Record<string, unknown> };
}> {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`No handler registered for ${channel}`);
  const requestId = options.requestId ?? `req-${Math.random()}`;
  const envelope = { requestId, payload };
  const result = (await handler(
    trustedSender as unknown as TestIpcEvent,
    envelope,
  )) as {
    ok: boolean;
    data?: T;
    error?: {
      code: string;
      message: string;
      details?: Record<string, unknown>;
    };
  };
  return result;
}

beforeEach(() => {
  vi.clearAllMocks();
  // Defaults: empty scope, CAS reports "updated", no wallet in inventory.
  // `getWalletById` returns `null` (not undefined) to mirror the real helper.
  mocks.getSessionWalletScope.mockResolvedValue({
    ok: true,
    data: { evm: null, solana: null },
  });
  mocks.initializeSessionWalletScope.mockResolvedValue({
    ok: true,
    data: { status: "updated" },
  });
  mocks.getWalletById.mockReturnValue(null);
  setupHandlers();
});

afterEach(() => {
  if (cleanups) for (const c of cleanups) c();
  cleanups = null;
  handlers.clear();
});

describe("listSessionWallets session wallet scope", () => {
  it("returns the empty {sessionId, evm:null, solana:null} DTO when nothing is selected", async () => {
    const result = await call(CH.wallets.listSessionWallets, {
      sessionId: SESSION,
    });
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({
      sessionId: SESSION,
      evm: null,
      solana: null,
    });
    // No selection → no inventory lookup.
    expect(mocks.getWalletById).not.toHaveBeenCalled();
  });

  it("maps a selected wallet to the DTO (address from scope row, label from inventory)", async () => {
    mocks.getSessionWalletScope.mockResolvedValueOnce({
      ok: true,
      data: { evm: { id: "evm-1", address: "0xabc" }, solana: null },
    });
    mocks.getWalletById.mockReturnValueOnce({
      id: "evm-1",
      address: "0xabc",
      label: "Main EVM",
    });
    const result = await call(CH.wallets.listSessionWallets, {
      sessionId: SESSION,
    });
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({
      sessionId: SESSION,
      evm: { walletId: "evm-1", address: "0xabc", label: "Main EVM" },
      solana: null,
    });
    expect(mocks.getWalletById).toHaveBeenCalledWith("evm", "evm-1");
  });

  it("propagates a DB error (fails closed, no DTO)", async () => {
    // Mirror the real `dbError` VexError shape so registerHandler passes it
    // through unchanged — a malformed error becomes internal.contract_violation.
    mocks.getSessionWalletScope.mockResolvedValueOnce({
      ok: false,
      error: {
        code: "internal.unexpected",
        domain: "internal",
        message: "Unable to complete the session operation.",
        retryable: true,
        userActionable: false,
        redacted: true,
      },
    });
    const result = await call(CH.wallets.listSessionWallets, {
      sessionId: SESSION,
    });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("internal.unexpected");
  });
});

describe("setSessionWalletScope session wallet scope", () => {
  it("resolves ids server-side and persists via initializeSessionWalletScope", async () => {
    mocks.getWalletById.mockImplementation((family: string, id: string) => ({
      id,
      address: family === "evm" ? "0xevm" : "solAddr",
      label: "W",
    }));
    const result = await call(CH.wallets.setSessionWalletScope, {
      sessionId: SESSION,
      evmWalletId: "evm-1",
      solanaWalletId: "sol-1",
    });
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({
      sessionId: SESSION,
      status: "updated",
      message: "Wallet selection saved.",
    });
    // Renderer sends ids only; main resolves the {id,address} ref pair.
    expect(mocks.initializeSessionWalletScope).toHaveBeenCalledWith(
      SESSION,
      { id: "evm-1", address: "0xevm" },
      { id: "sol-1", address: "solAddr" },
    );
  });

  it("fails closed with wallets.invalid_selection on an unknown id and writes nothing", async () => {
    // Default getWalletById → null → resolveWalletRef returns "invalid".
    const result = await call(CH.wallets.setSessionWalletScope, {
      sessionId: SESSION,
      evmWalletId: "ghost",
      solanaWalletId: null,
    });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("wallets.invalid_selection");
    expect(mocks.initializeSessionWalletScope).not.toHaveBeenCalled();
  });

  it("post-reset stale wallet scope fails closed with wallets.invalid_selection", async () => {
    const result = await call(CH.wallets.setSessionWalletScope, {
      sessionId: SESSION,
      evmWalletId: "wallet-from-pre-reset-inventory",
      solanaWalletId: null,
    });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("wallets.invalid_selection");
    expect(mocks.initializeSessionWalletScope).not.toHaveBeenCalled();
  });
});
