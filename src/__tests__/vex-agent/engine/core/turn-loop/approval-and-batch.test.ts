import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { StreamChunk } from "@vex-agent/inference/types.js";

// ── Mocks ─────────────────────────────────────────────────────

const mockAddMessage = vi.fn();
const mockAddEngineMessage = vi.fn();
const mockGetLiveMessages = vi.fn().mockResolvedValue([]);
const mockGetOperatorInstructionsAfter = vi.fn().mockResolvedValue([]);
const mockDispatchTool = vi.fn();
const mockIncrementIterations = vi.fn().mockResolvedValue(1);
const mockUpdateStatus = vi.fn();
const mockSetLastCheckpoint = vi.fn();

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

// Puzzle 2 `engine/events/index.ts` barrel routes assistant + engine message
// writes through `appendMessage` / `appendEngineMessage` (own-tx +
// emit-after-commit). The engine-internal `turn.ts` / `operator-instructions`
// / runner internals all import via this barrel, so mocking it here maps the
// new API back to the legacy `mockAddMessage` / `mockAddEngineMessage` spies
// that existing tests already assert on. Event-spine behavior is owned by
// `append-transcript.test.ts`; tests here only care about transcript writes.
vi.mock("@vex-agent/engine/events/index.js", () => ({
  appendMessage: (...a: unknown[]) => mockAddMessage(...a),
  appendEngineMessage: (...a: unknown[]) => mockAddEngineMessage(...a),
  emitTranscriptAppend: vi.fn(),
  // 9-5a: executeTurn emits stream deltas through this barrel. Stub the bus so
  // a streaming provider used in these tests doesn't crash on `emit`.
  streamDeltaBus: { emit: vi.fn(), subscribe: vi.fn(), size: vi.fn(), clear: vi.fn() },
  toStreamDeltaEvent: vi.fn(),
}));

vi.mock("@vex-agent/db/repos/mission-runs.js", () => ({
  incrementIterations: (...a: unknown[]) => mockIncrementIterations(...a),
  updateStatus: (...a: unknown[]) => mockUpdateStatus(...a),
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

// PR2 cutover: the post-compact resume packet is fetched from DB inside the
// turn loop via `buildResumePacket`. The implementation runs SQL queries via
// `@vex-agent/db/client.js` (already mocked above) and falls back to "" on
// any failure / empty result, so the default mocks keep the resume packet
// empty by design — tests that exercise the bridge counter add their own
// db client mocks to inject content.

vi.mock("@vex-agent/db/repos/approvals.js", () => ({
  enqueue: vi.fn(),
  enqueueWith: vi.fn(),
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
  // Puzzle 2 / puzzle 3 additions — production code now goes through these.
  getPool: vi.fn().mockReturnValue({
    connect: vi.fn().mockResolvedValue({
      query: vi.fn().mockResolvedValue({ rows: [] }),
      release: vi.fn(),
    }),
  }),
  queryWith: vi.fn().mockResolvedValue([]),
  // SQL-aware: only the message INSERT...RETURNING gets a fabricated row so
  // `addMessageReturningId` does not throw "no row". Lease / control SQL
  // queries default to null — those paths are covered by the dedicated
  // `lease-and-status` mock below.
  queryOneWith: vi.fn().mockImplementation(async (_exec: unknown, sql: string) => {
    if (typeof sql === "string" && sql.includes("INSERT INTO messages") && sql.includes("RETURNING id, created_at")) {
      return { id: 1, created_at: new Date().toISOString() };
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

// Puzzle 3 atomic lease helpers — production calls these via dynamic imports
// from runner/turn-loop/wake paths. Default outcomes: claimed lease + no
// pending control request. Per-test overrides via `mockImplementationOnce`.
vi.mock("@vex-agent/engine/runtime/lease-and-status.js", () => ({
  claimRunLeaseAndFlipToRunning: vi.fn().mockResolvedValue({
    outcome: "claimed",
    previousStatus: "paused_wake",
    lease: {
      sessionId: "s",
      missionRunId: "r",
      ownerId: "test-owner",
      processKind: "electron_main",
      acquiredAt: new Date(),
      heartbeatAt: new Date(),
      expiresAt: new Date(),
    },
    wakeCancelledCount: 0,
  }),
  claimSessionLease: vi.fn().mockResolvedValue({
    outcome: "claimed",
    lease: {
      sessionId: "s",
      missionRunId: null,
      ownerId: "test-owner",
      processKind: "electron_main",
      acquiredAt: new Date(),
      heartbeatAt: new Date(),
      expiresAt: new Date(),
    },
  }),
  observeAndApplyControl: vi.fn().mockResolvedValue({ outcome: "no_request" }),
}));

vi.mock("@vex-agent/engine/runtime/lease-handle.js", () => ({
  createLeaseHandle: vi.fn().mockReturnValue({
    lease: {
      sessionId: "s",
      missionRunId: null,
      ownerId: "test-owner",
      processKind: "electron_main",
      acquiredAt: new Date(),
      heartbeatAt: new Date(),
      expiresAt: new Date(),
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

// Spy on getOpenAITools (real impl preserved) so band-recompute tests can
// observe the per-turn ToolVisibilityContext that buildTurnPromptStack now
// projects the tools array from — replacing the removed per-band callback.
const mockGetOpenAITools = vi.hoisted(() => vi.fn());
vi.mock("@vex-agent/tools/registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@vex-agent/tools/registry.js")>();
  return {
    ...actual,
    getOpenAITools: (ctx: Parameters<typeof actual.getOpenAITools>[0]) => {
      mockGetOpenAITools(ctx);
      return actual.getOpenAITools(ctx);
    },
  };
});

const { runTurnLoop } = await import("../../../../../vex-agent/engine/core/turn-loop.js");

describe("turn-loop", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSessionForLoop.mockResolvedValue({ tokenCount: 0 });
    mockForcedFallback.mockResolvedValue({
      kind: "committed",
      generation: 1,
      archivedMessages: 3,
      jobId: 7,
      redactionCounts: { hard: 0, mask: 0 },
      planMode: "prefix",
    });
  });

  function makeContext(overrides = {}) {
    return {
      sessionId: "session-1",
      sessionKind: "agent" as const,
      sessionPermission: "restricted" as const,
      missionId: null,
      missionRunId: null,
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
    promptTokens?: number;
  }>) {
    let callIndex = 0;
    return {
      chatCompletion: vi.fn().mockImplementation(() => {
        const resp = responses[callIndex] ?? responses[responses.length - 1];
        callIndex++;
        return Promise.resolve({
          content: resp.content ?? null,
          toolCalls: resp.toolCalls ?? null,
          usage: {
            promptTokens: resp.promptTokens ?? 1000,
            completionTokens: 200,
            cachedTokens: 0,
            reasoningTokens: 0,
          },
        });
      }),
      calculateCost: vi.fn().mockReturnValue({ totalCost: 0.001, currency: "USD", breakdown: { promptCost: 0, completionCost: 0, cachedSavings: 0, reasoningCost: 0 } }),
    };
  }

  // 9-5a: a provider whose stream the consumer can abort. `chatCompletion` is
  // present (so a non-streaming fallback would be visible) but must NOT be
  // called when streaming aborts.
  function makeStreamingProvider(stream: () => AsyncGenerator<StreamChunk>) {
    return {
      chatCompletionStream: stream,
      chatCompletion: vi.fn(),
      calculateCost: vi.fn().mockReturnValue({ totalCost: 0.001, currency: "USD", breakdown: { promptCost: 0, completionCost: 0, cachedSavings: 0, reasoningCost: 0 } }),
    };
  }

  function makeConfig() {
    return {
      provider: "openrouter",
      model: "test-model",
      contextLimit: 128000,
      maxOutputTokens: 4096,
      inputPricePerM: 3,
      outputPricePerM: 15,
    };
  }

  const defaultLoopConfig = {
    maxIterations: 10,
    timeoutMs: 60000,
    contextLimit: 128000,
  };

  // ── Approval pause ──────────────────────────────────────────

  describe("approval pause", () => {
    it("throws when pendingApproval=true but dispatch result lacks actionKind", async () => {
      // Codex 2 phase-2 invariant: `approval_intents.action_kind` is NOT
      // NULL. The dispatcher's `withActionKindFallback` MUST stamp a kind
      // before `pendingApproval` returns; a missing stamp means the tool
      // is unregistered or the dispatcher fallback was bypassed. Fail
      // fast at the enqueue site instead of silently inserting a
      // pseudo-kind that masks the bug.
      const provider = makeProvider([
        { toolCalls: [{ id: "call-1", name: "execute_tool", arguments: { toolId: "solana.swap" } }] },
      ]);
      mockDispatchTool.mockResolvedValue({
        success: false,
        output: "Approval required",
        pendingApproval: true,
        // actionKind: intentionally omitted to exercise the throw path
      });

      await expect(
        runTurnLoop(
          makeContext({ sessionKind: "mission", missionRunId: "run-1", sessionPermission: "restricted" }),
          [], null, 0, provider as any, makeConfig() as any, [],
          defaultLoopConfig,
        ),
      ).rejects.toThrow(/Approval intent requires result\.actionKind/);

      // Neither approval row nor intent row was written (the throw fires
      // BEFORE the transaction body — withTransaction body never runs).
      expect(mockUpdateStatus).not.toHaveBeenCalledWith(
        "run-1",
        "paused_approval",
        expect.anything(),
        expect.anything(),
        expect.anything(),
      );
    });

    it("enqueues queue + intent + mission status flip in a single transaction", async () => {
      // Codex final review puzzle 5/2 — pin the transactional contract:
      // `withTransaction(fn)` calls `enqueueWith`, `createWith`, and
      // `updateStatus(..., client)` with the SAME PoolClient. A partial
      // state (queue without intent, or queue+intent without paused_approval)
      // is unrepresentable.
      const provider = makeProvider([
        { toolCalls: [{ id: "call-1", name: "execute_tool", arguments: { toolId: "kyberswap.swap.execute", params: { chain: "base" } } }] },
      ]);
      mockDispatchTool.mockResolvedValue({
        success: false,
        output: "Approval required",
        pendingApproval: true,
        actionKind: "user_wallet_broadcast",
      });

      // Re-import the mocked modules so we can spy on the per-call PoolClient.
      const dbClient = await import("@vex-agent/db/client.js");
      const approvalsMod = await import("@vex-agent/db/repos/approvals.js");
      const intentsMod = await import("@vex-agent/db/repos/approval-intents.js");
      const enqueueWithSpy = approvalsMod.enqueueWith as unknown as ReturnType<typeof vi.fn>;
      const createWithSpy = intentsMod.createWith as unknown as ReturnType<typeof vi.fn>;
      const withTransactionSpy = dbClient.withTransaction as unknown as ReturnType<typeof vi.fn>;

      await runTurnLoop(
        makeContext({ sessionKind: "mission", missionRunId: "run-1", sessionPermission: "restricted" }),
        [], null, 0, provider as any, makeConfig() as any, [],
        defaultLoopConfig,
      );

      expect(withTransactionSpy).toHaveBeenCalled();
      expect(enqueueWithSpy).toHaveBeenCalledTimes(1);
      expect(createWithSpy).toHaveBeenCalledTimes(1);
      expect(mockUpdateStatus).toHaveBeenCalledWith(
        "run-1",
        "paused_approval",
        "approval_required",
        undefined,
        expect.anything(),
      );

      // Each of the three writes received the SAME PoolClient — the tx
      // body cannot half-execute. enqueueWith(client, ...), createWith(client, ...),
      // updateStatus(..., client).
      const enqueueClient = enqueueWithSpy.mock.calls[0]?.[0];
      const createClient = createWithSpy.mock.calls[0]?.[0];
      const updateClient = mockUpdateStatus.mock.calls.find(
        (c: unknown[]) => c[1] === "paused_approval",
      )?.[4];
      expect(enqueueClient).toBeDefined();
      expect(createClient).toBe(enqueueClient);
      expect(updateClient).toBe(enqueueClient);
    });

    it("pauses on pendingApproval from dispatch", async () => {
      const provider = makeProvider([
        { toolCalls: [{ id: "call-1", name: "execute_tool", arguments: { toolId: "solana.swap" } }] },
      ]);
      mockDispatchTool.mockResolvedValue({
        success: false,
        output: "Approval required for swap",
        pendingApproval: true,
        // Puzzle 5 phase 2: enqueue site requires actionKind on
        // pendingApproval results — real dispatcher stamps via
        // `withActionKindFallback` / protocol runtime derive. Mocks
        // must include it explicitly or the throw fires.
        actionKind: "user_wallet_broadcast",
      });

      const result = await runTurnLoop(
        makeContext({ sessionKind: "mission", missionRunId: "run-1", sessionPermission: "restricted" }),
        [], null, 0, provider as any, makeConfig() as any, [],
        defaultLoopConfig,
      );

      expect(result.stopReason).toBe("approval_required");
      expect(result.pendingApprovals).toHaveLength(1);
      expect(result.pendingApprovals[0]).toMatch(/^approval-/);
      // Puzzle 5 phase 2 changed updateStatus signature to accept an
      // optional PoolClient as the 5th arg (transactional enqueue).
      expect(mockUpdateStatus).toHaveBeenCalledWith(
        "run-1",
        "paused_approval",
        "approval_required",
        undefined,
        expect.anything(),
      );
    });
  });

  // ── Batch approval trimming ────────────────────────────────

  describe("batch approval", () => {
    it("trims assistant message to canonical prefix on approval break", async () => {
      const provider = makeProvider([
        {
          toolCalls: [
            { id: "call-1", name: "web_research", arguments: { query: "test" } },
            { id: "call-2", name: "execute_tool", arguments: { toolId: "solana.swap" } },
            { id: "call-3", name: "wallet_balances", arguments: {} },
          ],
        },
      ]);

      let callIndex = 0;
      mockDispatchTool.mockImplementation(() => {
        callIndex++;
        if (callIndex === 2) {
          return Promise.resolve({
            success: false,
            output: "Approval required",
            pendingApproval: true,
            actionKind: "user_wallet_broadcast", // phase 2: required for approval enqueue
          });
        }
        return Promise.resolve({ success: true, output: `result-${callIndex}` });
      });

      const result = await runTurnLoop(
        makeContext({ sessionKind: "mission", missionRunId: "run-1", sessionPermission: "restricted" }),
        [], null, 0, provider as any, makeConfig() as any, [],
        defaultLoopConfig,
      );

      expect(result.stopReason).toBe("approval_required");

      // Assistant message should contain only call-1 and call-2 (dispatched), NOT call-3
      const assistantSave = mockAddMessage.mock.calls.find(
        (c: unknown[]) => (c[1] as Record<string, unknown>).role === "assistant",
      );
      expect(assistantSave).toBeTruthy();
      const savedToolCalls = (assistantSave![1] as Record<string, unknown>).toolCalls as Array<Record<string, unknown>>;
      expect(savedToolCalls).toHaveLength(2);
      expect(savedToolCalls[0].id).toBe("call-1");
      expect(savedToolCalls[1].id).toBe("call-2");
    });

    it("does NOT save tool_result for approval call", async () => {
      const provider = makeProvider([
        {
          toolCalls: [
            { id: "call-1", name: "web_research", arguments: { query: "test" } },
            { id: "call-2", name: "execute_tool", arguments: { toolId: "solana.swap" } },
          ],
        },
      ]);

      let callIndex = 0;
      mockDispatchTool.mockImplementation(() => {
        callIndex++;
        if (callIndex === 2) {
          return Promise.resolve({
            success: false,
            output: "Approval required",
            pendingApproval: true,
            actionKind: "user_wallet_broadcast", // phase 2: required for approval enqueue
          });
        }
        return Promise.resolve({ success: true, output: "search-result" });
      });

      await runTurnLoop(
        makeContext({ sessionKind: "mission", missionRunId: "run-1", sessionPermission: "restricted" }),
        [], null, 0, provider as any, makeConfig() as any, [],
        defaultLoopConfig,
      );

      // Tool results saved: only call-1 (the successful one)
      const toolResults = mockAddMessage.mock.calls.filter(
        (c: unknown[]) => (c[1] as Record<string, unknown>).role === "tool",
      );
      expect(toolResults).toHaveLength(1);
      expect((toolResults[0][1] as Record<string, unknown>).toolCallId).toBe("call-1");
    });

    it("returns current turn content as text on approval break", async () => {
      const provider = makeProvider([
        {
          content: "I'll swap SOL for USDC now.",
          toolCalls: [
            { id: "call-1", name: "execute_tool", arguments: { toolId: "solana.swap" } },
          ],
        },
      ]);

      mockDispatchTool.mockResolvedValue({
        success: false,
        output: "Approval required",
        pendingApproval: true,
        actionKind: "user_wallet_broadcast",
      });

      const result = await runTurnLoop(
        makeContext({ sessionKind: "mission", missionRunId: "run-1", sessionPermission: "restricted" }),
        [], null, 0, provider as any, makeConfig() as any, [],
        defaultLoopConfig,
      );

      expect(result.stopReason).toBe("approval_required");
      expect(result.text).toBe("I'll swap SOL for USDC now.");
    });
  });

  // ── Batch engine signal trimming ───────────────────────────

  describe("batch engine signal", () => {
    it("trims unexecuted calls after engine signal", async () => {
      const provider = makeProvider([
        {
          toolCalls: [
            { id: "call-1", name: "web_research", arguments: { query: "market" } },
            { id: "call-2", name: "mission_stop", arguments: { reason: "goal_reached", summary: "Done" } },
            { id: "call-3", name: "wallet_balances", arguments: {} },
          ],
        },
      ]);

      let callIndex = 0;
      mockDispatchTool.mockImplementation(() => {
        callIndex++;
        if (callIndex === 2) {
          return Promise.resolve({
            success: true,
            output: "Mission stop: goal_reached",
            engineSignal: { type: "stop_mission", reason: "goal_reached", summary: "Done" },
          });
        }
        return Promise.resolve({ success: true, output: `result-${callIndex}` });
      });

      const result = await runTurnLoop(
        makeContext({ sessionKind: "mission", missionRunId: "run-1" }),
        [], null, 0, provider as any, makeConfig() as any, [],
        defaultLoopConfig,
      );

      expect(result.stopReason).toBe("goal_reached");

      // Assistant message: call-1 + call-2, NOT call-3
      const assistantSave = mockAddMessage.mock.calls.find(
        (c: unknown[]) => (c[1] as Record<string, unknown>).role === "assistant",
      );
      const savedToolCalls = (assistantSave![1] as Record<string, unknown>).toolCalls as Array<Record<string, unknown>>;
      expect(savedToolCalls).toHaveLength(2);

      // Tool results: both call-1 and call-2 (engine signal call gets result saved)
      const toolResults = mockAddMessage.mock.calls.filter(
        (c: unknown[]) => (c[1] as Record<string, unknown>).role === "tool",
      );
      expect(toolResults).toHaveLength(2);
    });

    it("stop_mission returns stopPayload with summary and evidence", async () => {
      const provider = makeProvider([
        { toolCalls: [{ id: "call-1", name: "mission_stop", arguments: {} }] },
      ]);

      mockDispatchTool.mockResolvedValue({
        success: true,
        output: "Mission stop: goal_reached",
        engineSignal: {
          type: "stop_mission",
          reason: "goal_reached",
          summary: "Accumulated target SOL",
          evidence: { balanceSol: 10.5 },
        },
      });

      const result = await runTurnLoop(
        makeContext({ sessionKind: "mission", missionRunId: "run-1" }),
        [], null, 0, provider as any, makeConfig() as any, [],
        defaultLoopConfig,
      );

      expect(result.stopReason).toBe("goal_reached");
      expect(result.stopPayload).toBeDefined();
      expect(result.stopPayload!.summary).toBe("Accumulated target SOL");
      expect(result.stopPayload!.evidence).toEqual({ balanceSol: 10.5 });
    });
  });
});
