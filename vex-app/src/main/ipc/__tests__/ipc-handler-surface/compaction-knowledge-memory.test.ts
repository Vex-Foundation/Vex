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
  // memory-inspector-db
  listInspectorCandidates: vi.fn(),
  listInspectorDecisions: vi.fn(),
  getJobsSummary: vi.fn(),
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

vi.mock("../../../database/memory-inspector-db.js", () => ({
  listInspectorCandidates: mocks.listInspectorCandidates,
  listInspectorDecisions: mocks.listInspectorDecisions,
  getJobsSummary: mocks.getJobsSummary,
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
const { registerMemoryInspectorHandlers } = await import(
  "../../memory-inspector.js"
);
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
  registerMemoryInspectorHandlers();
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

describe("compaction handler", () => {
  it("registers the compaction-v2 preparation channels alongside the Track-2 ones", () => {
    // The apply button is dead without these two; a silent drop from
    // `registerCompactionHandlers` would otherwise only surface at runtime.
    expect(handlers.has(CH.compaction.getPreparation)).toBe(true);
    expect(handlers.has(CH.compaction.requestApply)).toBe(true);
  });

  it("getStatus returns the mapped status DTO", async () => {
    mocks.getCompactionStatus.mockResolvedValueOnce({
      ok: true,
      data: {
        sessionId: SESSION,
        latest: {
          status: "running",
          checkpointGeneration: 2,
          updatedAt: "2026-05-21T10:00:00.000Z",
        },
        activeCount: 1,
      },
    });
    const result = await call(CH.compaction.getStatus, { sessionId: SESSION });
    expect(result.ok).toBe(true);
    expect(mocks.getCompactionStatus).toHaveBeenCalledWith(SESSION);
  });

  it("getStatus returns a null result for a missing/foreign-scope session", async () => {
    mocks.getCompactionStatus.mockResolvedValueOnce({ ok: true, data: null });
    const result = await call(CH.compaction.getStatus, { sessionId: SESSION });
    expect(result.ok).toBe(true);
    expect(result.data).toBeNull();
  });

  it("getStatus rejects a non-uuid sessionId", async () => {
    const result = await call(CH.compaction.getStatus, { sessionId: "nope" });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("validation.invalid_input");
  });

  it("preserves a compaction-domain DB error (not downgraded)", async () => {
    mocks.getCompactionStatus.mockResolvedValueOnce({
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
    const result = await call(CH.compaction.getStatus, { sessionId: SESSION });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error?.code).toBe("internal.unexpected");
    expect(result.error?.domain).toBe("compaction");
  });

  it("listHistory returns the timeline array", async () => {
    mocks.listCompactionHistory.mockResolvedValueOnce({ ok: true, data: [] });
    const result = await call(CH.compaction.listHistory, {
      sessionId: SESSION,
      limit: 50,
    });
    expect(result.ok).toBe(true);
    expect(mocks.listCompactionHistory).toHaveBeenCalledWith(SESSION, 50);
  });

  it("listHistory returns null for a missing/foreign session", async () => {
    mocks.listCompactionHistory.mockResolvedValueOnce({ ok: true, data: null });
    const result = await call(CH.compaction.listHistory, {
      sessionId: SESSION,
      limit: 50,
    });
    expect(result.ok).toBe(true);
    expect(result.data).toBeNull();
  });
});

describe("long-memory handler", () => {
  it("list returns the sanitized array and passes the parsed input", async () => {
    mocks.listLongMemory.mockResolvedValueOnce({ ok: true, data: [] });
    const result = await call(CH.longMemory.list, { limit: 100 });
    expect(result.ok).toBe(true);
    expect(mocks.listLongMemory).toHaveBeenCalledWith({ limit: 100 });
  });

  it("list rejects an out-of-range limit (bounded input)", async () => {
    const result = await call(CH.longMemory.list, { limit: 100_000 });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("validation.invalid_input");
  });
});

describe("memory-inspector handlers (S10 - read-only)", () => {
  it("listCandidates returns the sanitized array and passes the parsed input", async () => {
    mocks.listInspectorCandidates.mockResolvedValueOnce({ ok: true, data: [] });
    const result = await call(CH.memoryInspector.listCandidates, {
      limit: 100,
    });
    expect(result.ok).toBe(true);
    expect(mocks.listInspectorCandidates).toHaveBeenCalledWith({ limit: 100 });
  });

  it("listCandidates rejects an out-of-range limit (bounded input)", async () => {
    const result = await call(CH.memoryInspector.listCandidates, {
      limit: 100_000,
    });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("validation.invalid_input");
  });

  it("listDecisions returns the sanitized array and passes the parsed input", async () => {
    mocks.listInspectorDecisions.mockResolvedValueOnce({ ok: true, data: [] });
    const result = await call(CH.memoryInspector.listDecisions, {
      decisionType: "promote",
      limit: 50,
    });
    expect(result.ok).toBe(true);
    expect(mocks.listInspectorDecisions).toHaveBeenCalledWith({
      decisionType: "promote",
      limit: 50,
    });
  });

  it("listDecisions rejects an out-of-range limit (bounded input)", async () => {
    const result = await call(CH.memoryInspector.listDecisions, {
      limit: 100_000,
    });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("validation.invalid_input");
  });

  it("jobsSummary returns the summary DTO and passes the parsed input", async () => {
    mocks.getJobsSummary.mockResolvedValueOnce({
      ok: true,
      data: {
        countsByStatus: {
          pending: 0,
          running: 0,
          completed: 0,
          failed: 0,
          permanently_failed: 0,
          retired: 0,
        },
        recentJobs: [],
      },
    });
    const result = await call(CH.memoryInspector.jobsSummary, {
      recentLimit: 20,
    });
    expect(result.ok).toBe(true);
    expect(mocks.getJobsSummary).toHaveBeenCalledWith({ recentLimit: 20 });
  });

  it("jobsSummary rejects an out-of-range recentLimit (bounded input)", async () => {
    const result = await call(CH.memoryInspector.jobsSummary, {
      recentLimit: 100_000,
    });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("validation.invalid_input");
  });
});

describe("memory handlers", () => {
  it("listSession returns null for a missing/foreign session", async () => {
    mocks.listSessionMemories.mockResolvedValueOnce({ ok: true, data: null });
    const result = await call(CH.memory.listSession, {
      sessionId: SESSION,
      limit: 50,
    });
    expect(result.ok).toBe(true);
    expect(result.data).toBeNull();
    expect(mocks.listSessionMemories).toHaveBeenCalledWith(SESSION, 50);
  });

  it("listSession rejects a non-uuid sessionId", async () => {
    const result = await call(CH.memory.listSession, {
      sessionId: "nope",
      limit: 50,
    });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("validation.invalid_input");
  });

  it("getStats returns the stats DTO", async () => {
    mocks.getMemoryStats.mockResolvedValueOnce({
      ok: true,
      data: {
        activeCount: 2,
        compactCount: 3,
        unresolvedOutstandingCount: 1,
        recentThemes: ["t"],
      },
    });
    const result = await call(CH.memory.getStats, { sessionId: SESSION });
    expect(result.ok).toBe(true);
    expect(mocks.getMemoryStats).toHaveBeenCalledWith(SESSION);
  });
});
