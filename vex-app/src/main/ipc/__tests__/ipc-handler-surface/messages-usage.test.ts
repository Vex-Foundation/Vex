/**
 * IPC handler surface smoke tests — sender validation, payload validation,
 * read-only success paths, and mutation handler registration. One file
 * bundles the broad surface to keep CI run-time tight.
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

const handlers = vi.hoisted(() => new Map<string, Handler>());
const mocks = vi.hoisted(() => ({
  // messages-db
  getMessageTail: vi.fn(),
  getMessageAround: vi.fn(),
  listMessages: vi.fn(),
  // usage-db
  getSessionTotals: vi.fn(),
  getLastTurn: vi.fn(),
  getContextWindow: vi.fn(),
  // compaction-db
  getCompactionStatus: vi.fn(),
  listCompactionHistory: vi.fn(),
  // long-memory-db
  listLongMemory: vi.fn(),
  // memory-db
  listSessionMemories: vi.fn(),
  getMemoryStats: vi.fn(),
  // mission-runs-db
  getActiveRunForSession: vi.fn(),
  // approvals-db
  listPendingForSession: vi.fn(),
  listPendingAllApprovals: vi.fn(),
  getApprovalById: vi.fn(),
  getHistoryForSession: vi.fn(),
  // missions-db
  getDraftForSession: vi.fn(),
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

vi.mock("../../../database/messages-db.js", () => ({
  getMessageTail: mocks.getMessageTail,
  getMessageAround: mocks.getMessageAround,
  listMessages: mocks.listMessages,
}));

vi.mock("../../../database/usage-db.js", () => ({
  getSessionTotals: mocks.getSessionTotals,
  getLastTurn: mocks.getLastTurn,
  getContextWindow: mocks.getContextWindow,
}));

vi.mock("../../../database/compaction-db.js", () => ({
  getCompactionStatus: mocks.getCompactionStatus,
  listCompactionHistory: mocks.listCompactionHistory,
  getRetryableCompactJob: vi.fn(),
  probeCompactJobsReady: vi.fn(),
}));

vi.mock("../../../database/long-memory-db.js", () => ({
  listLongMemory: mocks.listLongMemory,
}));

vi.mock("../../../database/memory-db.js", () => ({
  listSessionMemories: mocks.listSessionMemories,
  getMemoryStats: mocks.getMemoryStats,
}));

vi.mock("../../../database/mission-runs-db.js", () => ({
  getActiveRunForSession: mocks.getActiveRunForSession,
}));

vi.mock("../../../database/approvals-db.js", () => ({
  listPendingForSession: mocks.listPendingForSession,
  listPendingAllApprovals: mocks.listPendingAllApprovals,
  getApprovalById: mocks.getApprovalById,
  getHistoryForSession: mocks.getHistoryForSession,
}));

vi.mock("../../../database/missions-db.js", () => ({
  getDraftForSession: mocks.getDraftForSession,
}));

vi.mock("../../../logger/index.js", () => ({ log: mocks.log }));

const { registerMessagesHandlers } = await import("../../messages.js");
const { registerUsageHandlers } = await import("../../usage.js");
const { registerCompactionHandlers } = await import("../../compaction.js");
const { registerLongMemoryHandlers } = await import("../../long-memory.js");
const { registerMemoryHandlers } = await import("../../memory.js");
const { registerRuntimeHandlers } = await import("../../runtime.js");
const { registerMissionHandlers } = await import("../../mission.js");
const { registerApprovalsHandlers } = await import("../../approvals.js");
const { registerWalletsSessionHandlers } = await import("../../wallets-session.js");
const { registerModelsHandlers } = await import("../../models.js");
const { registerSessionsGetModelHandler } = await import("../../sessions/get-model.js");
const { CH } = await import("@shared/ipc/channels.js");

const trustedSender = createTrustedSender({ sender: createTestWebContents() });
const SESSION = "00000000-0000-4000-8000-00000000fff1";

function untrustedSender(): TestIpcEvent {
  return {
    senderFrame: {
      url: "https://evil.example",
      parent: null,
      top: null as never,
    },
    sender: createTestWebContents(),
  };
}

beforeEach(() => {
  handlers.clear();
  vi.clearAllMocks();
  registerMessagesHandlers();
  registerUsageHandlers();
  registerCompactionHandlers();
  registerLongMemoryHandlers();
  registerMemoryHandlers();
  registerRuntimeHandlers();
  registerMissionHandlers();
  registerApprovalsHandlers();
  registerWalletsSessionHandlers();
  registerModelsHandlers();
  registerSessionsGetModelHandler();
});

afterEach(() => {
  handlers.clear();
  delete process.env.AGENT_PROVIDER;
  delete process.env.AGENT_MODEL;
  delete process.env.AGENT_CONTEXT_LIMIT;
});

type ResultShape = { ok: boolean; data?: unknown; error?: { code: string; domain: string } };

async function call(channel: string, payload: unknown): Promise<ResultShape> {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`Handler not registered: ${channel}`);
  return (await fn(trustedSender, { requestId: "test-corr", payload })) as ResultShape;
}

async function callUntrusted(channel: string, payload: unknown): Promise<ResultShape> {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`Handler not registered: ${channel}`);
  return (await fn(untrustedSender(), {
    requestId: "test-corr",
    payload,
  })) as ResultShape;
}

describe("messages handlers", () => {
  it("getTail returns mapped page from db helper", async () => {
    mocks.getMessageTail.mockResolvedValueOnce({
      ok: true,
      data: { items: [], nextCursor: null, hasMore: false },
    });
    const result = await call(CH.messages.getTail, {
      sessionId: SESSION,
      limit: 5,
    });
    expect(result.ok).toBe(true);
    expect(mocks.getMessageTail).toHaveBeenCalledWith(SESSION, 5);
  });

  it("getTail rejects invalid payload (non-uuid sessionId)", async () => {
    const result = await call(CH.messages.getTail, {
      sessionId: "not-a-uuid",
    });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("validation.invalid_input");
  });

  it("getTail rejects untrusted sender frame URL", async () => {
    const result = await callUntrusted(CH.messages.getTail, {
      sessionId: SESSION,
      limit: 1,
    });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("validation.invalid_sender");
  });

  it("list passes cursor + limit to db helper", async () => {
    mocks.listMessages.mockResolvedValueOnce({
      ok: true,
      data: { items: [], nextCursor: null, hasMore: false },
    });
    await call(CH.messages.list, {
      sessionId: SESSION,
      cursor: { createdAt: "2026-05-21T10:00:00.000Z", id: 5 },
      limit: 25,
    });
    expect(mocks.listMessages).toHaveBeenCalledWith(
      SESSION,
      { createdAt: "2026-05-21T10:00:00.000Z", id: 5 },
      25,
    );
  });
});

describe("usage handlers", () => {
  it("getSessionTotals returns mapped totals", async () => {
    mocks.getSessionTotals.mockResolvedValueOnce({
      ok: true,
      data: {
        sessionId: SESSION,
        totalPromptTokens: 0,
        totalCompletionTokens: 0,
        totalTokens: 0,
        totalCachedTokens: 0,
        totalCost: null,
        totalCachedSavings: null,
        currency: "USD",
        requestCount: 0,
        lastRequestAt: null,
      },
    });
    const result = await call(CH.usage.getSessionTotals, {
      sessionId: SESSION,
      currency: "USD",
    });
    expect(result.ok).toBe(true);
  });

  it("getSessionTotals passes a NEGATIVE cached-savings total through the result schema (no .min(0))", async () => {
    mocks.getSessionTotals.mockResolvedValueOnce({
      ok: true,
      data: {
        sessionId: SESSION,
        totalPromptTokens: 1000,
        totalCompletionTokens: 100,
        totalTokens: 1100,
        totalCachedTokens: 200,
        totalCost: 0.01,
        totalCachedSavings: -0.0033,
        currency: "USD",
        requestCount: 1,
        lastRequestAt: "2026-05-21T10:00:00.000Z",
      },
    });
    const result = await call(CH.usage.getSessionTotals, {
      sessionId: SESSION,
      currency: "USD",
    });
    expect(result.ok).toBe(true);
    expect((result.data as { totalCachedSavings: number }).totalCachedSavings).toBeCloseTo(-0.0033, 6);
  });

  it("getLastTurn returns a turn DTO carrying the cache-savings fields", async () => {
    mocks.getLastTurn.mockResolvedValueOnce({
      ok: true,
      data: {
        sessionId: SESSION,
        promptTokens: 100,
        completionTokens: 50,
        totalTokens: 150,
        cachedTokens: 30,
        reasoningTokens: 0,
        cost: 0.001,
        cachedSavings: 0.0004,
        cacheWriteTokens: 12,
        currency: "USD",
        provider: "openrouter",
        model: "anthropic/claude-opus-4.7",
        createdAt: "2026-05-21T10:00:00.000Z",
      },
    });
    const result = await call(CH.usage.getLastTurn, {
      sessionId: SESSION,
      currency: "USD",
    });
    expect(result.ok).toBe(true);
    expect((result.data as { cacheWriteTokens: number }).cacheWriteTokens).toBe(12);
  });

  it("getLastTurn rejects payload without sessionId", async () => {
    const result = await call(CH.usage.getLastTurn, { currency: "USD" });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("validation.invalid_input");
  });

  it("getContextWindow passes the resolved env limit to the db helper", async () => {
    process.env.AGENT_CONTEXT_LIMIT = "200000";
    mocks.getContextWindow.mockResolvedValueOnce({
      ok: true,
      data: { sessionId: SESSION, tokensUsed: 1234, contextLimit: 200000 },
    });
    const result = await call(CH.usage.getContextWindow, { sessionId: SESSION });
    expect(result.ok).toBe(true);
    expect(mocks.getContextWindow).toHaveBeenCalledWith(SESSION, 200000);
  });

  it("getContextWindow passes a null limit when AGENT_CONTEXT_LIMIT is invalid (no faked default)", async () => {
    process.env.AGENT_CONTEXT_LIMIT = "not-a-number";
    mocks.getContextWindow.mockResolvedValueOnce({ ok: true, data: null });
    const result = await call(CH.usage.getContextWindow, { sessionId: SESSION });
    expect(result.ok).toBe(true);
    expect(mocks.getContextWindow).toHaveBeenCalledWith(SESSION, null);
  });

  it("getContextWindow returns a null result for a missing/deleted session", async () => {
    mocks.getContextWindow.mockResolvedValueOnce({ ok: true, data: null });
    const result = await call(CH.usage.getContextWindow, { sessionId: SESSION });
    expect(result.ok).toBe(true);
    expect(result.data).toBeNull();
  });

  it("getContextWindow stamps the ENGINE's pressure bands onto the window", async () => {
    // Single source of truth: the fractions come from the engine policy
    // module, never from a renderer-side constant. Imported here so a change
    // to the policy moves this expectation with it.
    const policy = await import(
      "@vex-agent/engine/core/context-pressure-policy.js"
    );
    process.env.AGENT_CONTEXT_LIMIT = "200000";
    mocks.getContextWindow.mockResolvedValueOnce({
      ok: true,
      data: { sessionId: SESSION, tokensUsed: 1234, contextLimit: 200000 },
    });
    const result = await call(CH.usage.getContextWindow, { sessionId: SESSION });
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({
      sessionId: SESSION,
      tokensUsed: 1234,
      contextLimit: 200000,
      pressureWarningFraction: policy.PRESSURE_WARNING_FRACTION,
      pressureBarrierFraction: policy.PRESSURE_BARRIER_FRACTION,
      pressureCriticalFraction: policy.PRESSURE_CRITICAL_FRACTION,
    });
  });

  it("getContextWindow leaves a NULL window null - no bands on a session that does not exist", async () => {
    mocks.getContextWindow.mockResolvedValueOnce({ ok: true, data: null });
    const result = await call(CH.usage.getContextWindow, { sessionId: SESSION });
    expect(result.ok).toBe(true);
    expect(result.data).toBeNull();
  });

  it("getContextWindow rejects a non-uuid sessionId", async () => {
    const result = await call(CH.usage.getContextWindow, { sessionId: "nope" });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("validation.invalid_input");
  });
});
