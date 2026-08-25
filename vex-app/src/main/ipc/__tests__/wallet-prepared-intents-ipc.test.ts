/**
 * Wallet prepared-intent IPC handlers.
 *
 * Pinned invariants:
 *   - `ensureEngineDbUrl` first; DB failure short-circuits to err.
 *   - getPreparedIntent: ok(DTO | null), session-scoped getById, allow-listed
 *     mapper drops failure_reason + idempotency_key
 *   - cancelPreparedIntent: ok({status:'cancelled'}) on CAS win,
 *     ok({status:'already_terminal'}) on race miss OR cross-session
 *   - cross-session calls do NOT expose existence
 *   - listSessionWallets / setSessionWalletScope registered; focused
 *     contract in session-wallet-scope-ipc.test.ts
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
  ensureEngineDbUrl: vi.fn().mockResolvedValue({ ok: true, data: undefined }),
  getById: vi.fn(),
  cancelIfPending: vi.fn(),
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

vi.mock("../runtime/_ensure-engine-db-url.js", () => ({
  ensureEngineDbUrl: (...a: unknown[]) => mocks.ensureEngineDbUrl(...a),
}));

vi.mock("@vex-agent/db/repos/wallet-intents.js", () => ({
  getById: (...a: unknown[]) => mocks.getById(...a),
  cancelIfPendingWith: (...a: unknown[]) => mocks.cancelIfPending(...a),
  createWith: vi.fn(),
  consumeIfPendingWith: vi.fn(),
  markExecutedWith: vi.fn(),
  markFailedWith: vi.fn(),
  markAuditFailedWith: vi.fn(),
  getPendingForSession: vi.fn(),
}));

// Cancellation is a money-state writer: it runs inside a session-control-locked
// transaction (compaction contract C7). Stub the lock so this IPC test stays
// pool-free; `SENTINEL_CLIENT` is the repo mock's first argument.
const SENTINEL_CLIENT = { __sessionControlLocked: true } as const;
vi.mock("@vex-agent/engine/runtime/lease-and-status/session-control-lock.js", () => ({
  withSessionControlLock: (_sessionId: string, fn: (c: unknown) => unknown) =>
    Promise.resolve(fn(SENTINEL_CLIENT)),
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
  const result = (await handler(trustedSender as unknown as TestIpcEvent, envelope)) as {
    ok: boolean;
    data?: T;
    error?: { code: string; message: string; details?: Record<string, unknown> };
  };
  return result;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.ensureEngineDbUrl.mockResolvedValue({ ok: true, data: undefined });
  setupHandlers();
});

afterEach(() => {
  if (cleanups) for (const c of cleanups) c();
  cleanups = null;
  handlers.clear();
});

// ── Fixtures ────────────────────────────────────────────────────────────

function makeIntent(
  overrides: Partial<{
    status: string;
    txHash: string | null;
    failureReason: string | null;
    idempotencyKey: string | null;
  }> = {},
): Record<string, unknown> {
  return {
    intentId: "intent-1",
    sessionId: SESSION,
    walletAddress: "0xabcdef1234567890abcdef1234567890abcdef12",
    network: "eip155",
    chainAlias: "base",
    toAddress: "0xfedcba0987654321fedcba0987654321fedcba09",
    amount: "1.5",
    token: null,
    previewJson: { label: "Send 1.5 native to 0xfed…cba09 on base", criticalArgs: {} },
    status: "pending",
    activityId: null,
    expiresAt: "2026-05-25T10:00:00.000Z",
    consumedAt: null,
    cancelledAt: null,
    txHash: null,
    failureReason: null,
    idempotencyKey: "intent-1",
    repairCheckedAt: null,
    createdAt: "2026-05-24T20:00:00.000Z",
    ...overrides,
  };
}

// ── getPreparedIntent ───────────────────────────────────────────────────

describe("getPreparedIntent handler", () => {
  it("ensureEngineDbUrl err short-circuits with same Result", async () => {
    mocks.ensureEngineDbUrl.mockResolvedValueOnce({
      ok: false,
      error: {
        code: "internal.unexpected",
        domain: "runtime",
        message: "DB unavailable",
        retryable: true,
        userActionable: true,
        redacted: true,
        correlationId: "x",
      },
    });

    const result = await call(CH.wallets.getPreparedIntent, {
      sessionId: SESSION,
      intentId: "intent-1",
    });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("internal.unexpected");
    expect(mocks.getById).not.toHaveBeenCalled();
  });

  it("returns ok(null) when intent not found", async () => {
    mocks.getById.mockResolvedValueOnce(null);
    const result = await call(CH.wallets.getPreparedIntent, {
      sessionId: SESSION,
      intentId: "missing",
    });
    expect(result.ok).toBe(true);
    expect(result.data).toBeNull();
    expect(mocks.getById).toHaveBeenCalledWith("missing", SESSION);
  });

  it("returns allow-listed DTO; failure_reason + idempotency_key are NOT surfaced", async () => {
    mocks.getById.mockResolvedValueOnce(
      makeIntent({
        status: "failed",
        txHash: "0xtxFailed",
        failureReason: "TypeError:abc123abc123abcd",
        idempotencyKey: "intent-1",
      }),
    );
    const result = await call(CH.wallets.getPreparedIntent, {
      sessionId: SESSION,
      intentId: "intent-1",
    });
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      intentId: "intent-1",
      sessionId: SESSION,
      walletAddress: "0xabcdef1234567890abcdef1234567890abcdef12",
      network: "eip155",
      chain: "base",
      to: "0xfedcba0987654321fedcba0987654321fedcba09",
      amount: "1.5",
      token: null,
      status: "failed",
      txHash: "0xtxFailed",
    });
    // Defense-in-depth: structural failure_reason + idempotency_key
    // intentionally absent from the renderer DTO.
    expect(result.data).not.toHaveProperty("failureReason");
    expect(result.data).not.toHaveProperty("idempotencyKey");
  });

  it.each(["broadcast_unconfirmed", "superseded_unproven", "review_required"])(
    "projects the durable %s lifecycle status without coercion",
    async (status) => {
      mocks.getById.mockResolvedValueOnce(makeIntent({ status, txHash: "0xunresolved" }));
      const result = await call(CH.wallets.getPreparedIntent, {
        sessionId: SESSION,
        intentId: "intent-1",
      });
      expect(result.ok).toBe(true);
      expect(result.data).toMatchObject({ status, txHash: "0xunresolved" });
    },
  );

  it("preview Zod safeparse drops malformed JSONB to null (defense-in-depth)", async () => {
    mocks.getById.mockResolvedValueOnce(
      makeIntent({}),
    );
    // Override previewJson on the returned intent
    mocks.getById.mockReset();
    mocks.getById.mockResolvedValueOnce({
      ...makeIntent(),
      previewJson: { unexpected: "shape" }, // doesn't match walletIntentPreviewSchema
    });
    const result = await call(CH.wallets.getPreparedIntent, {
      sessionId: SESSION,
      intentId: "intent-1",
    });
    expect(result.ok).toBe(true);
    expect((result.data as { preview: unknown }).preview).toBeNull();
  });

  it("cross-session sessionId yields ok(null) (no exposure of existence)", async () => {
    // Repo getById receives the requesting sessionId; it returns null for
    // any other session (CAS predicate has session_id = $2).
    mocks.getById.mockResolvedValueOnce(null);
    const result = await call(CH.wallets.getPreparedIntent, {
      sessionId: "00000000-0000-4000-8000-9999999999bb",
      intentId: "intent-1",
    });
    expect(result.ok).toBe(true);
    expect(result.data).toBeNull();
    expect(mocks.getById).toHaveBeenCalledWith(
      "intent-1",
      "00000000-0000-4000-8000-9999999999bb",
    );
  });

  it("repo throws → err internal.unexpected", async () => {
    mocks.getById.mockRejectedValueOnce(new Error("DB connection lost"));
    const result = await call(CH.wallets.getPreparedIntent, {
      sessionId: SESSION,
      intentId: "intent-1",
    });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("internal.unexpected");
  });
});

// ── cancelPreparedIntent ────────────────────────────────────────────────

describe("cancelPreparedIntent handler", () => {
  it("ensureEngineDbUrl err short-circuits", async () => {
    mocks.ensureEngineDbUrl.mockResolvedValueOnce({
      ok: false,
      error: {
        code: "internal.unexpected",
        domain: "runtime",
        message: "DB unavailable",
        retryable: true,
        userActionable: true,
        redacted: true,
        correlationId: "x",
      },
    });

    const result = await call(CH.wallets.cancelPreparedIntent, {
      sessionId: SESSION,
      intentId: "intent-1",
    });
    expect(result.ok).toBe(false);
    expect(mocks.cancelIfPending).not.toHaveBeenCalled();
  });

  it("CAS win → ok({status:'cancelled'})", async () => {
    mocks.cancelIfPending.mockResolvedValueOnce(
      makeIntent({ status: "cancelled" }),
    );
    const result = await call(CH.wallets.cancelPreparedIntent, {
      sessionId: SESSION,
      intentId: "intent-1",
    });
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      intentId: "intent-1",
      status: "cancelled",
    });
    expect(mocks.cancelIfPending).toHaveBeenCalledWith(SENTINEL_CLIENT, "intent-1", SESSION);
  });

  it("CAS miss (already terminal) → ok({status:'already_terminal'})", async () => {
    mocks.cancelIfPending.mockResolvedValueOnce(null);
    const result = await call(CH.wallets.cancelPreparedIntent, {
      sessionId: SESSION,
      intentId: "intent-1",
    });
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      intentId: "intent-1",
      status: "already_terminal",
    });
  });

  it("cross-session cancel → ok({status:'already_terminal'}) (no exposure)", async () => {
    // Repo cancelIfPending also returns null when session_id mismatches;
    // handler collapses to 'already_terminal' without exposing existence.
    mocks.cancelIfPending.mockResolvedValueOnce(null);
    const result = await call(CH.wallets.cancelPreparedIntent, {
      sessionId: "00000000-0000-4000-8000-9999999999bb",
      intentId: "intent-1",
    });
    expect(result.ok).toBe(true);
    expect((result.data as { status: string }).status).toBe("already_terminal");
    // Message MUST NOT reveal that intent exists in another session
    expect((result.data as { message: string }).message).not.toContain(
      "another session",
    );
  });

  it("repo throws → err internal.unexpected", async () => {
    mocks.cancelIfPending.mockRejectedValueOnce(new Error("DB throw"));
    const result = await call(CH.wallets.cancelPreparedIntent, {
      sessionId: SESSION,
      intentId: "intent-1",
    });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("internal.unexpected");
  });
});

// ── listSessionWallets / setSessionWalletScope registration smoke ───────

describe("wallet scope handler registration", () => {
  // Focused contract lives in `session-wallet-scope-ipc.test.ts`,
  // `wallet-refs.test.ts`
  // (resolveWalletRef + invalid_selection), and `database/__tests__/
  // sessions-wallet-scope.test.ts` (CAS + missions.allowed_wallets). Here we
  // only assert the handlers are registered (smoke regression).
  it("listSessionWallets / setSessionWalletScope handlers are registered", () => {
    expect(handlers.has(CH.wallets.listSessionWallets)).toBe(true);
    expect(handlers.has(CH.wallets.setSessionWalletScope)).toBe(true);
  });
});
