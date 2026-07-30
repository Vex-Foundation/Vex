/**
 * Turn-loop integration of the `defer_until` engine signal.
 *
 * Covered here:
 *   - `loop_defer` tool emission parks the mission run in `paused_wake`
 *     (both the mission_runs.updateStatus call and the returned stopReason).
 *   - State exclusivity / precedence:
 *       - `approval_required` in the same batch wins over a later `loop_defer`
 *         (turn-loop breaks on approval first, so the defer never dispatches).
 *       - `stop_mission` in the same batch wins over a later `loop_defer`.
 *   - Forced-compact-before-wait: when `contextUsageBand === "critical"` at the
 *     moment of wake entry, `maybeRunForcedCompactFallback()` fires BEFORE the
 *     mission_runs.updateStatus flip to `paused_wake`, so post-wake resume
 *     starts from a compacted prompt and no concurrent wake claim / user
 *     preempt races a running compaction (audit M-3).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockAddMessage = vi.fn();
const mockAddEngineMessage = vi.fn();
const mockGetLiveMessages = vi.fn().mockResolvedValue([]);
const mockDispatchTool = vi.fn();
const mockIncrementIterations = vi.fn().mockResolvedValue(1);
// Resolves `true` so the terminal-safe CAS (`updateStatusIfNotTerminal`) reads
// as "the write landed"; `updateStatus` ignores the value.
const mockUpdateStatus = vi.fn().mockResolvedValue(true);
const mockSetLastCheckpoint = vi.fn();
const mockEnqueueApproval = vi.fn();

const mockGetOperatorInstructionsAfter = vi.fn().mockResolvedValue([]);

// The turn loop registers a compaction-apply boundary action. Stubbed inert
// here: none of these tests exercise compaction, and the real module pulls the
// archive/messages graph these harnesses deliberately mock. The action's own
// behaviour lives in `turn-loop/compaction-apply-consumer.test.ts`.
vi.mock("@vex-agent/engine/compaction/apply/index.js", () => ({
  createCompactionApplyAction: () => ({
    name: "compaction_apply",
    phase: "apply" as const,
    run: async () => ({ kind: "continue" as const }),
  }),
}));

vi.mock("@vex-agent/db/repos/messages.js", () => ({
  addMessage: (...a: unknown[]) => mockAddMessage(...a),
  addEngineMessage: (...a: unknown[]) => mockAddEngineMessage(...a),
  addMessageReturningId: vi.fn().mockResolvedValue({
    id: 1,
    role: "assistant",
    content: "",
    timestamp: new Date().toISOString(),
  }),
  getLiveMessages: (...a: unknown[]) => mockGetLiveMessages(...a),
  getOperatorInstructionsAfter: (...a: unknown[]) => mockGetOperatorInstructionsAfter(...a),
}));

// Puzzle 2: engine writes transcript via `events/index.ts` barrel.
// Map back to existing legacy spies so transcript-write assertions pass.
vi.mock("@vex-agent/engine/events/index.js", () => ({
  appendMessage: (...a: unknown[]) => mockAddMessage(...a),
  appendEngineMessage: (...a: unknown[]) => mockAddEngineMessage(...a),
  emitTranscriptAppend: vi.fn(),
}));

vi.mock("@vex-agent/db/repos/mission-runs.js", () => ({
  incrementIterations: (...a: unknown[]) => mockIncrementIterations(...a),
  updateStatus: (...a: unknown[]) => mockUpdateStatus(...a),
  // The critical-band escalation writes `paused_error` through the terminal-safe
  // CAS so an operator Stop that landed during the forced compaction is not
  // overwritten. Same spy, same assertions — the guard is what changed.
  updateStatusIfNotTerminal: (...a: unknown[]) => mockUpdateStatus(...a),
  setLastCheckpoint: (...a: unknown[]) => mockSetLastCheckpoint(...a),
}));

vi.mock("@vex-agent/tools/dispatcher.js", () => ({
  dispatchTool: (...a: unknown[]) => mockDispatchTool(...a),
}));

const mockGetSessionForLoop = vi.fn().mockResolvedValue({ tokenCount: 0 });

vi.mock("@vex-agent/db/repos/sessions.js", () => ({
  updateTokenCount: vi.fn(),
  setRollingSummary: vi.fn(),
  archivePrefix: vi.fn(),
  forkToolMessageToArchive: vi.fn(),
  getSession: (...a: unknown[]) => mockGetSessionForLoop(...a),
}));

const mockForcedFallback = vi.fn().mockResolvedValue({
  kind: "committed",
  generation: 1,
  archivedMessages: 3,
  jobId: 7,
  redactionCounts: { hard: 0, mask: 0 },
  planMode: "prefix",
});

vi.mock("@vex-agent/engine/compact-jobs/forced-fallback.js", () => ({
  maybeRunForcedCompactFallback: (...a: unknown[]) => mockForcedFallback(...a),
}));

vi.mock("@vex-agent/db/repos/approvals.js", () => ({
  enqueue: (...a: unknown[]) => mockEnqueueApproval(...a),
  enqueueWith: (...a: unknown[]) => mockEnqueueApproval(...a.slice(1)),
  // Used only by the enqueue transaction's dead-run auto-reject branch.
  rejectWith: vi.fn().mockResolvedValue(null),
}));

vi.mock("@vex-agent/db/repos/approval-intents.js", () => ({
  createWith: vi.fn(),
}));

vi.mock("@vex-agent/db/repos/usage.js", () => ({
  logUsage: vi.fn(),
}));

vi.mock("@vex-agent/db/client.js", () => ({
  execute: vi.fn(),
  query: vi.fn().mockResolvedValue([]),
  queryOne: vi.fn().mockResolvedValue(null),
  getPool: vi.fn().mockReturnValue({
    connect: vi.fn().mockResolvedValue({
      query: vi.fn().mockResolvedValue({ rows: [] }),
      release: vi.fn(),
    }),
  }),
  queryWith: vi.fn().mockResolvedValue([]),
  queryOneWith: vi.fn().mockImplementation(async (_exec: unknown, sql: string) => {
    if (typeof sql === "string" && sql.includes("INSERT INTO messages") && sql.includes("RETURNING id, created_at")) {
      return { id: 1, created_at: new Date().toISOString() };
    }
    // The approval-enqueue transaction re-reads the run under its row lock;
    // a live run keeps the normal `paused_approval` path.
    if (typeof sql === "string" && sql.includes("FROM mission_runs") && sql.includes("FOR UPDATE")) {
      return { status: "running" };
    }
    return null;
  }),
  executeWith: vi.fn().mockResolvedValue(1),
  withTransaction: vi.fn().mockImplementation(async (fn: (client: unknown) => Promise<unknown>) => {
    const stubClient = {
      query: vi.fn().mockResolvedValue({ rows: [] }),
      release: vi.fn(),
    };
    return await fn(stubClient);
  }),
}));

// Puzzle 3 atomic lease helpers.
vi.mock("@vex-agent/engine/runtime/lease-and-status.js", async (importOriginal) => ({
  // `importOriginal` on purpose: the operator-stop gate the approval
  // enqueue now runs must stay the REAL implementation, driven by the SQL
  // stubs above. Stubbing it out would turn the terminal-run assertions
  // below into a test of the mock.
  ...(await importOriginal<
    typeof import("@vex-agent/engine/runtime/lease-and-status.js")
  >()),
  claimRunLeaseAndFlipToRunning: vi.fn().mockResolvedValue({
    outcome: "claimed",
    previousStatus: "paused_wake",
    lease: {
      sessionId: "s", missionRunId: "r", ownerId: "test-owner",
      processKind: "electron_main",
      acquiredAt: new Date(), heartbeatAt: new Date(), expiresAt: new Date(),
    },
    wakeCancelledCount: 0,
  }),
  claimSessionLease: vi.fn().mockResolvedValue({
    outcome: "claimed",
    lease: {
      sessionId: "s", missionRunId: null, ownerId: "test-owner",
      processKind: "electron_main",
      acquiredAt: new Date(), heartbeatAt: new Date(), expiresAt: new Date(),
    },
  }),
  observeAndApplyControl: vi.fn().mockResolvedValue({ outcome: "no_request" }),
}));

vi.mock("@vex-agent/engine/runtime/lease-handle.js", () => ({
  createLeaseHandle: vi.fn().mockReturnValue({
    lease: {
      sessionId: "s", missionRunId: null, ownerId: "test-owner",
      processKind: "electron_main",
      acquiredAt: new Date(), heartbeatAt: new Date(), expiresAt: new Date(),
    },
    ownerId: "test-owner",
    release: vi.fn().mockResolvedValue(undefined),
    onLeaseLost: vi.fn(),
  }),
}));

vi.mock("@vex-agent/engine/runtime/release-and-emit.js", () => ({
  releaseLeaseAndEmitControlState: vi.fn().mockResolvedValue(undefined),
}));

// Wave 3: the $VEX own-token banner inside buildTurnPromptStack reaches the
// public DexScreener/Virtuals APIs — stub it so the turn loop stays hermetic
// ("" = banner omitted, the fail-soft contract).
vi.mock("@vex-agent/engine/prompts/own-token-banner.js", () => ({
  buildOwnTokenBanner: vi.fn().mockResolvedValue(""),
}));

vi.mock("@vex-agent/tools/protocols/catalog.js", () => ({
  PROTOCOL_TOOLS: [],
  PROTOCOL_NAMESPACE_ALLOWLIST: [],
}));

const { runTurnLoop } = await import("../../../../vex-agent/engine/core/turn-loop.js");

// ── Helpers ───────────────────────────────────────────────────

function makeContext(overrides = {}) {
  return {
    sessionId: "session-1",
    sessionKind: "mission" as const,
    sessionPermission: "restricted" as const,
    missionId: "mission-1",
    missionRunId: "run-1",
    selectedEvmWallet: null,
    selectedSolanaWallet: null,
    walletPolicy: { kind: "none" as const },
    loadedDocuments: new Map<string, string>(),
    ...overrides,
  };
}

function makeProvider(responses: Array<{
  content?: string | null;
  toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }> | null;
}>) {
  let callIndex = 0;
  return {
    chatCompletion: vi.fn().mockImplementation(() => {
      const resp = responses[callIndex] ?? responses[responses.length - 1];
      callIndex++;
      return Promise.resolve({
        content: resp.content ?? null,
        toolCalls: resp.toolCalls ?? null,
        usage: { promptTokens: 1000, completionTokens: 200, cachedTokens: 0, reasoningTokens: 0 },
      });
    }),
    calculateCost: vi.fn().mockReturnValue({ totalCost: 0.001, currency: "USD", breakdown: { promptCost: 0, completionCost: 0, cachedSavings: 0, reasoningCost: 0 } }),
  };
}

function makeConfig() {
  return {
    provider: "openrouter",
    model: "test-model",
    contextLimit: 128_000,
    timeoutMs: 300_000,
  };
}

function makeLoopConfig() {
  return {
    maxIterations: 5,
    timeoutMs: 300_000,
    contextLimit: 128_000,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetSessionForLoop.mockResolvedValue({ tokenCount: 0 });
});

// ── loop_defer → paused_wake ──────────────────────────────────

describe("turn-loop — defer_until signal", () => {
  it("parks mission run in paused_wake and returns waiting_for_wake stopReason", async () => {
    mockDispatchTool.mockResolvedValueOnce({
      success: true,
      output: "Loop deferred until 2026-04-20T11:00:00.000Z",
      data: { defer_id: "wake-xyz", due_at: "2026-04-20T11:00:00.000Z" },
      engineSignal: {
        type: "defer_until",
        reason: "waiting for settlement",
        summary: "Deferred until 2026-04-20T11:00:00.000Z",
        dueAt: "2026-04-20T11:00:00.000Z",
      },
    });

    const provider = makeProvider([
      {
        content: "Deferring until settlement completes.",
        toolCalls: [{ id: "tc-1", name: "loop_defer", arguments: { after_ms: 60_000, reason: "waiting for settlement" } }],
      },
    ]);

    const result = await runTurnLoop(
      makeContext(),
      [],
      null,
      0,
      provider as any,
      makeConfig() as any,
      [],
      makeLoopConfig(),
    );

    expect(result.stopReason).toBe("waiting_for_wake");
    expect(result.stopPayload?.evidence).toMatchObject({
      dueAt: "2026-04-20T11:00:00.000Z",
      reason: "waiting for settlement",
    });

    // Mission run flipped to paused_wake with the right stop reason.
    const updateCalls = mockUpdateStatus.mock.calls.filter((c) => c[0] === "run-1");
    expect(updateCalls.length).toBeGreaterThan(0);
    expect(updateCalls[updateCalls.length - 1][1]).toBe("paused_wake");
    expect(updateCalls[updateCalls.length - 1][2]).toBe("waiting_for_wake");
  });

  it("saves the assistant batch (user-facing message + tool call) before exiting", async () => {
    mockDispatchTool.mockResolvedValueOnce({
      success: true,
      output: "Loop deferred",
      engineSignal: {
        type: "defer_until",
        reason: "hint",
        summary: "deferred",
        dueAt: "2030-01-01T00:00:00.000Z",
      },
    });

    const provider = makeProvider([
      {
        content: "I'll pause until X.",
        toolCalls: [{ id: "tc-1", name: "loop_defer", arguments: { after_ms: 10_000, reason: "hint" } }],
      },
    ]);

    await runTurnLoop(
      makeContext(),
      [],
      null,
      0,
      provider as any,
      makeConfig() as any,
      [],
      makeLoopConfig(),
    );

    // The assistant message (with the tool call) is persisted by saveAssistantMessage →
    // messagesRepo.addMessage. The tool-result for loop_defer is also persisted.
    const toolResultCalls = mockAddMessage.mock.calls.filter((c) => c[1]?.role === "tool");
    expect(toolResultCalls.length).toBe(1);
  });
});

// ── Precedence ────────────────────────────────────────────────

describe("turn-loop — state exclusivity", () => {
  it("approval_required in the same batch wins over a later loop_defer (defer never dispatches)", async () => {
    // First tool triggers approval → turn-loop breaks before dispatching the
    // second (loop_defer), so mockDispatchTool is only called once.
    mockDispatchTool.mockResolvedValueOnce({
      success: false,
      output: "approval needed",
      pendingApproval: true,
      // Puzzle 5 phase 2: enqueue site throws if pendingApproval lacks
      // actionKind (production dispatcher stamps it via fallback; mock
      // must include it explicitly).
      actionKind: "approval_prepare",
    });

    const provider = makeProvider([
      {
        content: "Need approval then defer.",
        toolCalls: [
          { id: "tc-1", name: "wallet_send_prepare", arguments: {} },
          { id: "tc-2", name: "loop_defer", arguments: { after_ms: 10_000, reason: "then sleep" } },
        ],
      },
    ]);

    const result = await runTurnLoop(
      makeContext(),
      [],
      null,
      0,
      provider as any,
      makeConfig() as any,
      [],
      makeLoopConfig(),
    );

    expect(result.stopReason).toBe("approval_required");
    // Only the first tool dispatched.
    expect(mockDispatchTool).toHaveBeenCalledTimes(1);

    // Mission run moved to paused_approval, NOT paused_wake.
    const statusWrites = mockUpdateStatus.mock.calls.filter((c) => c[0] === "run-1");
    expect(statusWrites.some((c) => c[1] === "paused_approval")).toBe(true);
    expect(statusWrites.some((c) => c[1] === "paused_wake")).toBe(false);
  });

  it("stop_mission in the same batch wins over a later loop_defer", async () => {
    mockDispatchTool.mockResolvedValueOnce({
      success: true,
      output: "stopping",
      engineSignal: {
        type: "stop_mission",
        reason: "goal_reached",
        summary: "done",
      },
    });

    const provider = makeProvider([
      {
        content: "Done, but also deferring (should not take).",
        toolCalls: [
          { id: "tc-1", name: "mission_stop", arguments: { reason: "goal_reached", summary: "done" } },
          { id: "tc-2", name: "loop_defer", arguments: { after_ms: 10_000, reason: "no-op" } },
        ],
      },
    ]);

    const result = await runTurnLoop(
      makeContext(),
      [],
      null,
      0,
      provider as any,
      makeConfig() as any,
      [],
      makeLoopConfig(),
    );

    expect(result.stopReason).toBe("goal_reached");
    expect(mockDispatchTool).toHaveBeenCalledTimes(1);

    // Mission run never saw paused_wake.
    const statusWrites = mockUpdateStatus.mock.calls.filter((c) => c[0] === "run-1");
    expect(statusWrites.some((c) => c[1] === "paused_wake")).toBe(false);
  });
});

// ── Forced-compact-before-wait ────────────────────────────────

describe("turn-loop — forced-compact-before-wait", () => {
  it("does NOT run forced compact fallback when band is normal at wake entry", async () => {
    mockGetSessionForLoop.mockResolvedValue({ tokenCount: 10_000 }); // ~7.8%

    mockDispatchTool.mockResolvedValueOnce({
      success: true,
      output: "deferred",
      engineSignal: {
        type: "defer_until",
        reason: "hint",
        summary: "deferred",
        dueAt: "2030-01-01T00:00:00.000Z",
      },
    });

    const provider = makeProvider([
      {
        content: "Pausing.",
        toolCalls: [{ id: "tc-1", name: "loop_defer", arguments: { after_ms: 10_000, reason: "hint" } }],
      },
    ]);

    await runTurnLoop(
      makeContext(),
      [],
      null,
      0,
      provider as any,
      makeConfig() as any,
      [],
      makeLoopConfig(),
    );

    expect(mockForcedFallback).not.toHaveBeenCalled();
  });

  it("DOES run forced compact fallback when band is critical at wake entry", async () => {
    // 128_000 * 0.92 = 117_760 (PR2 cutover threshold) → 120_000 is critical.
    // The top-of-iteration check sees `currentTokenCount = 0` (initial) so it
    // does NOT trigger; the critical band is only observed via the freshly
    // queried `sessions.token_count` AT the waiting_for_wake branch. That
    // branch path is the one this test asserts.
    mockGetSessionForLoop.mockResolvedValue({ tokenCount: 120_000 });

    mockDispatchTool.mockResolvedValueOnce({
      success: true,
      output: "deferred",
      engineSignal: {
        type: "defer_until",
        reason: "pressure",
        summary: "deferred",
        dueAt: "2030-01-01T00:00:00.000Z",
      },
    });

    const provider = makeProvider([
      {
        content: "Pausing under pressure.",
        toolCalls: [{ id: "tc-1", name: "loop_defer", arguments: { after_ms: 10_000, reason: "pressure" } }],
      },
    ]);

    const result = await runTurnLoop(
      makeContext(),
      [],
      null,
      0,
      provider as any,
      makeConfig() as any,
      [],
      makeLoopConfig(),
    );

    expect(result.stopReason).toBe("waiting_for_wake");
    // Forced fallback fired so resume starts compacted.
    expect(mockForcedFallback).toHaveBeenCalledTimes(1);
  });

  it("runs forced compact fallback BEFORE flipping the run to paused_wake", async () => {
    mockGetSessionForLoop.mockResolvedValue({ tokenCount: 120_000 });

    mockDispatchTool.mockResolvedValueOnce({
      success: true,
      output: "deferred",
      engineSignal: {
        type: "defer_until",
        reason: "pressure",
        summary: "deferred",
        dueAt: "2030-01-01T00:00:00.000Z",
      },
    });

    const provider = makeProvider([
      {
        content: "Pausing under pressure.",
        toolCalls: [{ id: "tc-1", name: "loop_defer", arguments: { after_ms: 10_000, reason: "pressure" } }],
      },
    ]);

    await runTurnLoop(
      makeContext(),
      [],
      null,
      0,
      provider as any,
      makeConfig() as any,
      [],
      makeLoopConfig(),
    );

    // Both hooks were called once — this test asserts their RELATIVE order:
    // forced fallback must have landed before updateStatus(paused_wake) so
    // ingress / wake executor never see paused_wake during a running
    // compaction.
    const fallbackCall = mockForcedFallback.mock.invocationCallOrder[0];
    const pausedWakeCall = mockUpdateStatus.mock.invocationCallOrder.find((_, idx) => {
      const args = mockUpdateStatus.mock.calls[idx];
      return args && args[1] === "paused_wake";
    });
    expect(fallbackCall).toBeDefined();
    expect(pausedWakeCall).toBeDefined();
    expect(fallbackCall).toBeLessThan(pausedWakeCall!);
  });
});
