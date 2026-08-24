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

describe("DB helper errors preserve intended VexError shape", () => {
  it("DB helper error (internal.unexpected, no correlationId) survives registerHandler - code preserved, correlationId stamped", async () => {
    // Helpers must omit `correlationId` from error literals. An empty-string
    // correlationId is rejected by
    // `isValidVexErrorShape` (length === 0) and downgrades the public
    // error to `internal.contract_violation` — masking real DB faults.
    //
    // This test pins the contract: when a DB helper returns
    // `{ code: "internal.unexpected", domain: "messages", ... }` WITHOUT
    // a correlationId, the handler must:
    //   1. NOT downgrade the code to `internal.contract_violation`,
    //   2. stamp `ctx.requestId` into the final result.
    mocks.getMessageTail.mockResolvedValueOnce({
      ok: false,
      error: {
        code: "internal.unexpected",
        domain: "messages",
        message: "Database unavailable. Verify services are running and retry.",
        retryable: true,
        userActionable: true,
        redacted: true,
      },
    });
    const result = await call(CH.messages.getTail, {
      sessionId: SESSION,
      limit: 5,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error?.code).toBe("internal.unexpected");
    expect(result.error?.domain).toBe("messages");
    // registerHandler auto-stamps the request id when correlationId is missing.
    expect((result.error as { correlationId?: string }).correlationId).toBe(
      "test-corr",
    );
  });

  it("approvals DB helper error preserves approvals domain (not downgraded)", async () => {
    mocks.listPendingForSession.mockResolvedValueOnce({
      ok: false,
      error: {
        code: "internal.unexpected",
        domain: "approvals",
        message: "Unable to load approvals.",
        retryable: true,
        userActionable: false,
        redacted: true,
      },
    });
    const result = await call(CH.approvals.listPending, { sessionId: SESSION });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error?.code).toBe("internal.unexpected");
    expect(result.error?.domain).toBe("approvals");
  });
});
