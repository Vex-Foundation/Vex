/**
 * Focused contract test for `compaction.retry` (stage 8-5).
 *
 * Mocks the app-scope resolver (`compaction-db.getRetryableCompactJob`),
 * `ensureEngineDbUrl`, and the engine repo `resetPermanentlyFailed` so we can
 * assert the Result mapping + app-scope authorization without a live DB:
 *   resolver null              → compaction.not_found (engine untouched)
 *   resolver status != perm    → compaction.invalid_state (engine untouched)
 *   ok                         → { checkpointGeneration, status: "pending" } + reset(jobId)
 *   engine reason not_found    → compaction.not_found
 *   engine reason not_perm     → compaction.invalid_state
 *   ensureEngineDbUrl fail     → internal.unexpected (compaction)
 *   engine/import throw         → internal.unexpected (compaction)
 *   resolver err               → passthrough (compaction internal.unexpected)
 *   bad input                  → validation.invalid_input (before the resolver)
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
  ensureEngineDbUrl: vi.fn(),
  resetPermanentlyFailed: vi.fn(),
  getRetryableCompactJob: vi.fn(),
  getCompactionStatus: vi.fn(),
  listCompactionHistory: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
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

vi.mock("../../database/engine-db-readiness.js", () => ({
  ensureEngineDbUrl: mocks.ensureEngineDbUrl,
}));
vi.mock("@vex-agent/db/repos/compact-jobs/index.js", () => ({
  resetPermanentlyFailed: mocks.resetPermanentlyFailed,
}));
vi.mock("../../database/compaction-db.js", () => ({
  getCompactionStatus: mocks.getCompactionStatus,
  listCompactionHistory: mocks.listCompactionHistory,
  getRetryableCompactJob: mocks.getRetryableCompactJob,
}));
vi.mock("../../logger/index.js", () => ({ log: mocks.log }));

const { registerCompactionHandlers } = await import("../compaction.js");
const { CH } = await import("@shared/ipc/channels.js");

const trustedSender = createTrustedSender({ sender: createTestWebContents() });
const SESSION = "00000000-0000-4000-8000-0000000000c1";

type ResultShape = {
  ok: boolean;
  data?: unknown;
  error?: { code: string; domain: string };
};

async function call(channel: string, payload: unknown): Promise<ResultShape> {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`Handler not registered: ${channel}`);
  return (await fn(trustedSender, {
    requestId: "test-corr",
    payload,
  })) as ResultShape;
}

const PERM = { ok: true, data: { id: 42, status: "permanently_failed" } };

beforeEach(() => {
  handlers.clear();
  vi.clearAllMocks();
  mocks.ensureEngineDbUrl.mockResolvedValue({ ok: true, data: undefined });
  registerCompactionHandlers();
});

afterEach(() => {
  handlers.clear();
});

describe("compaction.retry handler", () => {
  it("ok → { checkpointGeneration, status:'pending' } and resets the resolved jobId", async () => {
    mocks.getRetryableCompactJob.mockResolvedValueOnce(PERM);
    mocks.resetPermanentlyFailed.mockResolvedValueOnce({ ok: true });
    const r = await call(CH.compaction.retry, {
      sessionId: SESSION,
      checkpointGeneration: 3,
    });
    expect(r.ok).toBe(true);
    expect(r.data).toEqual({ checkpointGeneration: 3, status: "pending" });
    expect(mocks.resetPermanentlyFailed).toHaveBeenCalledWith(42);
  });

  it("resolver null → compaction.not_found (engine + db-url untouched)", async () => {
    mocks.getRetryableCompactJob.mockResolvedValueOnce({ ok: true, data: null });
    const r = await call(CH.compaction.retry, {
      sessionId: SESSION,
      checkpointGeneration: 9,
    });
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("compaction.not_found");
    expect(r.error?.domain).toBe("compaction");
    expect(mocks.ensureEngineDbUrl).not.toHaveBeenCalled();
    expect(mocks.resetPermanentlyFailed).not.toHaveBeenCalled();
  });

  it("resolver non-permanently_failed → compaction.invalid_state (engine untouched)", async () => {
    mocks.getRetryableCompactJob.mockResolvedValueOnce({
      ok: true,
      data: { id: 7, status: "completed" },
    });
    const r = await call(CH.compaction.retry, {
      sessionId: SESSION,
      checkpointGeneration: 2,
    });
    expect(r.error?.code).toBe("compaction.invalid_state");
    expect(mocks.resetPermanentlyFailed).not.toHaveBeenCalled();
  });

  it("engine reason not_found (race) → compaction.not_found", async () => {
    mocks.getRetryableCompactJob.mockResolvedValueOnce(PERM);
    mocks.resetPermanentlyFailed.mockResolvedValueOnce({
      ok: false,
      reason: "not_found",
    });
    const r = await call(CH.compaction.retry, {
      sessionId: SESSION,
      checkpointGeneration: 1,
    });
    expect(r.error?.code).toBe("compaction.not_found");
  });

  it("engine reason not_permanently_failed (race) → compaction.invalid_state", async () => {
    mocks.getRetryableCompactJob.mockResolvedValueOnce(PERM);
    mocks.resetPermanentlyFailed.mockResolvedValueOnce({
      ok: false,
      reason: "not_permanently_failed",
    });
    const r = await call(CH.compaction.retry, {
      sessionId: SESSION,
      checkpointGeneration: 1,
    });
    expect(r.error?.code).toBe("compaction.invalid_state");
  });

  it("ensureEngineDbUrl failure → internal.unexpected (compaction), engine untouched", async () => {
    mocks.getRetryableCompactJob.mockResolvedValueOnce(PERM);
    mocks.ensureEngineDbUrl.mockResolvedValueOnce({
      ok: false,
      error: {
        code: "internal.unexpected",
        domain: "data",
        message: "db down",
        retryable: true,
        userActionable: true,
        redacted: true,
        correlationId: "c",
      },
    });
    const r = await call(CH.compaction.retry, {
      sessionId: SESSION,
      checkpointGeneration: 1,
    });
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("internal.unexpected");
    expect(r.error?.domain).toBe("compaction");
    expect(mocks.resetPermanentlyFailed).not.toHaveBeenCalled();
  });

  it("engine throw → internal.unexpected (compaction)", async () => {
    mocks.getRetryableCompactJob.mockResolvedValueOnce(PERM);
    mocks.resetPermanentlyFailed.mockRejectedValueOnce(new Error("boom"));
    const r = await call(CH.compaction.retry, {
      sessionId: SESSION,
      checkpointGeneration: 1,
    });
    expect(r.error?.code).toBe("internal.unexpected");
    expect(r.error?.domain).toBe("compaction");
  });

  it("resolver error passes through as a compaction internal.unexpected", async () => {
    mocks.getRetryableCompactJob.mockResolvedValueOnce({
      ok: false,
      error: {
        code: "internal.unexpected",
        domain: "compaction",
        message: "Unable to load compaction status.",
        retryable: true,
        userActionable: false,
        redacted: true,
      },
    });
    const r = await call(CH.compaction.retry, {
      sessionId: SESSION,
      checkpointGeneration: 1,
    });
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("internal.unexpected");
    expect(r.error?.domain).toBe("compaction");
    expect(mocks.resetPermanentlyFailed).not.toHaveBeenCalled();
  });

  it("rejects a bad session id before touching the resolver", async () => {
    const r = await call(CH.compaction.retry, {
      sessionId: "nope",
      checkpointGeneration: 1,
    });
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("validation.invalid_input");
    expect(mocks.getRetryableCompactJob).not.toHaveBeenCalled();
  });

  it("rejects a negative generation before touching the resolver", async () => {
    const r = await call(CH.compaction.retry, {
      sessionId: SESSION,
      checkpointGeneration: -1,
    });
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("validation.invalid_input");
    expect(mocks.getRetryableCompactJob).not.toHaveBeenCalled();
  });
});
