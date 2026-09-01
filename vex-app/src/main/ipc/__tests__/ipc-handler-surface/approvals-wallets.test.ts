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

describe("approvals handlers", () => {
  it("listPending returns mapped DTO array", async () => {
    mocks.listPendingForSession.mockResolvedValueOnce({ ok: true, data: [] });
    const result = await call(CH.approvals.listPending, { sessionId: SESSION });
    expect(result.ok).toBe(true);
    expect(result.data).toEqual([]);
  });

  it("listPendingAll handler is registered", () => {
    expect(handlers.has(CH.approvals.listPendingAll)).toBe(true);
  });

  it("listPendingAll returns the global DTO array (with sessionTitle)", async () => {
    const globalDto = {
      id: "g1",
      sessionId: SESSION,
      toolCallId: null,
      toolName: "wallet:send",
      status: "pending",
      permissionAtEnqueue: "restricted",
      createdAt: "2026-05-28T10:00:00.000Z",
      resolvedAt: null,
      reasoningPreview: "confirm transfer",
      actionKind: null,
      riskLevel: null,
      preview: null,
      expiresAt: null,
      decision: null,
      decisionReason: null,
      executionStatus: null,
      origin: "studio_mcp",
      projectId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
      sessionTitle: "My session",
      projectName: "Demo project",
    };
    mocks.listPendingAllApprovals.mockResolvedValueOnce({
      ok: true,
      data: [globalDto],
    });
    const result = await call(CH.approvals.listPendingAll, {});
    expect(result.ok).toBe(true);
    // The handler's output schema accepts the global DTO shape verbatim.
    expect(result.data).toEqual([globalDto]);
  });

  it("listPendingAll rejects a non-empty payload (strict empty input)", async () => {
    const result = await call(CH.approvals.listPendingAll, {
      sessionId: SESSION,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error?.code).toBe("validation.invalid_input");
  });

  // Approve/reject fail-closed assertions moved out.
  // Focused decision behavior is pinned in `approvals-decision-ipc.test.ts`; this
  // file keeps the smoke-level "handlers registered" coverage only.
  it("approve / reject handlers are registered", () => {
    // `handlers` map is the registered-handler shape from the `electron`
    // mock; presence here means register{Approve,Reject}Handler ran.
    expect(handlers.has(CH.approvals.approve)).toBe(true);
    expect(handlers.has(CH.approvals.reject)).toBe(true);
  });
});

describe("wallets-session handlers", () => {
  // listSessionWallets returns the DB-backed scope DTO.
  // setSessionWalletScope resolves ids and fails closed on unknown id. The
  // focused contract lives in `session-wallet-scope-ipc.test.ts`, `wallet-refs.test.ts`
  // (resolveWalletRef + invalid_selection), and `database/__tests__/
  // sessions-wallet-scope.test.ts` (CAS + allowed_wallets). Here we only check
  // the handlers exist after registration (smoke regression).
  it("listSessionWallets / setSessionWalletScope handlers are registered", () => {
    expect(handlers.has(CH.wallets.listSessionWallets)).toBe(true);
    expect(handlers.has(CH.wallets.setSessionWalletScope)).toBe(true);
  });

  // getPreparedIntent / cancelPreparedIntent are covered in
  // `wallet-prepared-intents-ipc.test.ts`. Here we only check
  // that the handlers exist after registration (smoke regression).
  it("getPreparedIntent / cancelPreparedIntent handlers are registered", () => {
    expect(handlers.has(CH.wallets.getPreparedIntent)).toBe(true);
    expect(handlers.has(CH.wallets.cancelPreparedIntent)).toBe(true);
  });
});
