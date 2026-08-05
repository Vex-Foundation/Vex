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
  // session-control-state — `runtime.getState` reads the aggregate directly
  // now, so the DTO's required `stoppable` is projected from one snapshot.
  readSessionControlFacts: vi.fn(),
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

vi.mock("../../../database/session-control-state.js", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../../../database/session-control-state.js")
  >();
  return { ...actual, readSessionControlFacts: mocks.readSessionControlFacts };
});
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

describe("runtime handlers", () => {
  it("getState returns mission run state with lease and pending-control fields", async () => {
    mocks.readSessionControlFacts.mockResolvedValueOnce({
      ok: true,
      data: {
        sessionId: SESSION,
        hasActiveRun: false,
        missionRunId: null,
        status: null,
        stopReason: null,
        lastCheckpointAt: null,
        startedAt: null,
        iterationCount: null,
        leaseActive: false,
        leaseExpiresAt: null,
        pendingControlKind: null,
        hasPendingWake: false,
        hasPendingApproval: false,
        hasIncompleteApprovalLifecycle: false,
        hasOutstandingUserForm: false,
      },
    });
    const result = await call(CH.runtime.getState, { sessionId: SESSION });
    expect(result.ok).toBe(true);
  });

  it("requestPause/Stop/Resume/cancelWake reach the DB-backed control handlers", async () => {
    // In this unit test environment there is no
    // Postgres connection, so the handlers fail at `ensureEngineDbUrl`
    // and surface `internal.unexpected`. This confirms the handlers
    // are no longer fail-closed by contract — they actually run.
    for (const ch of [
      CH.runtime.requestPause,
      CH.runtime.requestStop,
      CH.runtime.requestResume,
      CH.runtime.cancelWake,
    ]) {
      const result = await call(ch, { sessionId: SESSION });
      expect(result.ok).toBe(false);
      // The DB-backed handler fails at `ensureEngineDbUrl` in this
      // environment — anything else would mean a stub is back.
      expect(result.error?.code).toBe("internal.unexpected");
    }
  });
});

describe("mission handlers", () => {
  it("getDraft returns null when no draft for session", async () => {
    mocks.getDraftForSession.mockResolvedValueOnce({ ok: true, data: null });
    const result = await call(CH.mission.getDraft, { sessionId: SESSION });
    expect(result.ok).toBe(true);
    expect(result.data).toBeNull();
  });

  // Mission command coverage (per-command schema validation +
  // updateDraft fail-closed) lives in the focused files
  // under `__tests__/mission/` so this suite does not exceed the
  // 350-LOC budget.
});
