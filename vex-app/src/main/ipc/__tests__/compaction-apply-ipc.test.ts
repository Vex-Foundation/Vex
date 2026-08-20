/**
 * Contract test for the compaction-v2 preparation handlers.
 *
 * The three properties that matter, in order of consequence:
 *   1. the handler NEVER reaches a cutover primitive — it calls exactly one
 *      function on the apply gate, `requestApply`, and nothing else;
 *   2. it NEVER emits on the preparation bus (only the engine emits, and only
 *      post-commit);
 *   3. every racing state is a SUCCESSFUL result with an `outcome`, while an
 *      unknown/foreign session is a `compaction.not_found` error.
 *
 * The app-scope resolver, `ensureEngineDbUrl` and the engine apply gate are
 * mocked so the mapping is asserted without a live DB.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createTestWebContents,
  createTrustedSender,
  type TestIpcEvent,
} from "./test-sender.js";

type Handler = (event: TestIpcEvent, raw: unknown) => Promise<unknown>;

const handlers = vi.hoisted(() => new Map<string, Handler>());
const mocks = vi.hoisted(() => ({
  ensureEngineDbUrl: vi.fn(),
  requestApply: vi.fn(),
  commitPreparation: vi.fn(),
  consumeApplyRequest: vi.fn(),
  forcePreparedApply: vi.fn(),
  getCompactionPreparation: vi.fn(),
  getCompactionStatus: vi.fn(),
  listCompactionHistory: vi.fn(),
  getRetryableCompactJob: vi.fn(),
  busEmit: vi.fn(),
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

vi.mock("../runtime/_ensure-engine-db-url.js", () => ({
  ensureEngineDbUrl: mocks.ensureEngineDbUrl,
}));
vi.mock("@vex-agent/engine/compaction/apply/index.js", () => ({
  requestApply: mocks.requestApply,
  // The cutover doors exist on the real gate; exposing them here means an
  // implementation that reached for one would be caught by the call assertions
  // below rather than by an import error.
  commitPreparation: mocks.commitPreparation,
  consumeApplyRequest: mocks.consumeApplyRequest,
  forcePreparedApply: mocks.forcePreparedApply,
}));
vi.mock("@vex-agent/engine/runtime/compaction-bus.js", () => ({
  compactionPreparationBus: { emit: mocks.busEmit, subscribe: vi.fn() },
}));
vi.mock("../../database/compaction-preparation-db.js", () => ({
  getCompactionPreparation: mocks.getCompactionPreparation,
  probeCompactionPreparationsReady: vi.fn(),
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
const SESSION = "00000000-0000-4000-8000-0000000000c9";
const ISO = "2026-07-29T10:00:00.000Z";

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

const DTO = {
  sessionId: SESSION,
  status: "summary_ready" as const,
  summaryStatus: "succeeded" as const,
  chunksStatus: "pending" as const,
  summaryAttemptCount: 1,
  summaryMaxAttempts: 3,
  chunksAttemptCount: 0,
  chunksMaxAttempts: 3,
  hasSummary: true,
  applySource: null,
  applyRequestedAt: null,
  appliedAt: null,
  createdAt: ISO,
  completedAt: null,
};

beforeEach(() => {
  handlers.clear();
  vi.clearAllMocks();
  mocks.ensureEngineDbUrl.mockResolvedValue({ ok: true, data: undefined });
  mocks.getCompactionPreparation.mockResolvedValue({ ok: true, data: DTO });
  registerCompactionHandlers();
});

describe("compaction.getPreparation", () => {
  it("registers and returns the bounded DTO", async () => {
    const res = await call(CH.compaction.getPreparation, {
      sessionId: SESSION,
    });
    expect(res.ok).toBe(true);
    expect(res.data).toEqual(DTO);
  });

  it("returns null for a session with no preparation", async () => {
    mocks.getCompactionPreparation.mockResolvedValueOnce({
      ok: true,
      data: null,
    });
    const res = await call(CH.compaction.getPreparation, {
      sessionId: SESSION,
    });
    expect(res.ok).toBe(true);
    expect(res.data).toBeNull();
  });

  it("rejects a malformed session id before touching the database", async () => {
    mocks.getCompactionPreparation.mockClear();
    const res = await call(CH.compaction.getPreparation, {
      sessionId: "not-a-uuid",
    });
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("validation.invalid_input");
    expect(mocks.getCompactionPreparation).not.toHaveBeenCalled();
  });
});

describe("compaction.requestApply - outcome mapping", () => {
  const cases = [
    ["queued", "queued", "apply_requested"],
    ["queued_no_live_runner", "no_live_runner", "apply_requested"],
    ["already_requested", "already_requested", "apply_requested"],
  ] as const;

  for (const [engineKind, outcome, status] of cases) {
    it(`${engineKind} → ${outcome}`, async () => {
      mocks.requestApply.mockResolvedValueOnce({
        kind: engineKind,
        preparationId: 7,
      });
      const res = await call(CH.compaction.requestApply, {
        sessionId: SESSION,
      });
      expect(res.ok).toBe(true);
      expect(res.data).toEqual({ outcome, status });
    });
  }

  it("not_ready carries the live status so the renderer refreshes in one trip", async () => {
    mocks.requestApply.mockResolvedValueOnce({
      kind: "not_ready",
      preparationId: 7,
      status: "preparing",
    });
    const res = await call(CH.compaction.requestApply, { sessionId: SESSION });
    expect(res.ok).toBe(true);
    expect(res.data).toEqual({ outcome: "not_ready", status: "preparing" });
  });

  it("no_preparation → gone (a successful result, not an error)", async () => {
    mocks.requestApply.mockResolvedValueOnce({ kind: "no_preparation" });
    const res = await call(CH.compaction.requestApply, { sessionId: SESSION });
    expect(res.ok).toBe(true);
    expect(res.data).toEqual({ outcome: "gone" });
  });

  it("passes the UI provenance and calls the apply gate EXACTLY once", async () => {
    mocks.requestApply.mockResolvedValueOnce({ kind: "queued", preparationId: 1 });
    await call(CH.compaction.requestApply, { sessionId: SESSION });
    expect(mocks.requestApply).toHaveBeenCalledTimes(1);
    expect(mocks.requestApply).toHaveBeenCalledWith({
      sessionId: SESSION,
      source: "ui_button",
    });
  });
});

describe("compaction.requestApply - the renderer-authority boundary", () => {
  it("never reaches a cutover primitive", async () => {
    mocks.requestApply.mockResolvedValueOnce({ kind: "queued", preparationId: 1 });
    await call(CH.compaction.requestApply, { sessionId: SESSION });
    expect(mocks.commitPreparation).not.toHaveBeenCalled();
    expect(mocks.consumeApplyRequest).not.toHaveBeenCalled();
    expect(mocks.forcePreparedApply).not.toHaveBeenCalled();
  });

  it("never emits on the preparation bus - only the engine does, post-commit", async () => {
    mocks.requestApply.mockResolvedValueOnce({ kind: "queued", preparationId: 1 });
    await call(CH.compaction.requestApply, { sessionId: SESSION });
    expect(mocks.busEmit).not.toHaveBeenCalled();
  });
});

describe("compaction.requestApply - authorization and failures", () => {
  it("an unknown/foreign session is compaction.not_found and never reaches the engine", async () => {
    mocks.getCompactionPreparation.mockResolvedValueOnce({
      ok: true,
      data: null,
    });
    const res = await call(CH.compaction.requestApply, { sessionId: SESSION });
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("compaction.not_found");
    expect(res.error?.domain).toBe("compaction");
    expect(mocks.requestApply).not.toHaveBeenCalled();
  });

  it("an ensureEngineDbUrl failure is a redacted compaction internal.unexpected", async () => {
    mocks.ensureEngineDbUrl.mockResolvedValueOnce({
      ok: false,
      error: { code: "database.unavailable" },
    });
    const res = await call(CH.compaction.requestApply, { sessionId: SESSION });
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("internal.unexpected");
    expect(res.error?.domain).toBe("compaction");
    expect(mocks.requestApply).not.toHaveBeenCalled();
  });

  it("an engine throw is normalized, never surfaced raw", async () => {
    mocks.requestApply.mockRejectedValueOnce(new Error("lock timeout on 42"));
    const res = await call(CH.compaction.requestApply, { sessionId: SESSION });
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("internal.unexpected");
    expect(JSON.stringify(res)).not.toContain("lock timeout");
  });

  it("a resolver error passes through redacted", async () => {
    mocks.getCompactionPreparation.mockResolvedValueOnce({
      ok: false,
      error: {
        code: "internal.unexpected",
        domain: "compaction",
        message: "Unable to load compaction status.",
        retryable: true,
        userActionable: false,
        redacted: true,
        correlationId: "test-corr",
      },
    });
    const res = await call(CH.compaction.requestApply, { sessionId: SESSION });
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("internal.unexpected");
  });
});
