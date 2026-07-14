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
      isSubagent: false,
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

  // ── Iteration limit ─────────────────────────────────────────

  describe("iteration limit", () => {
    it("stops at maxIterations for mission", async () => {
      const provider = makeProvider([
        { content: "Still working..." },
        { content: "Still going..." },
      ]);

      const result = await runTurnLoop(
        makeContext({ sessionKind: "mission", missionRunId: "run-1" }),
        [], null, 0, provider as any, makeConfig() as any, [],
        { ...defaultLoopConfig, maxIterations: 0 },
      );

      expect(result.stopReason).toBe("iteration_limit");
    });
  });

  // ── Deferred save ──────────────────────────────────────────

  describe("deferred save", () => {
    it("saves assistant message with toolCalls to DB via deferred save", async () => {
      const provider = makeProvider([
        { toolCalls: [{ id: "call-1", name: "web_research", arguments: { query: "test" } }] },
        { content: "Done" },
      ]);
      mockDispatchTool.mockResolvedValue({ success: true, output: '{"results":[]}' });

      await runTurnLoop(
        makeContext(), [], null, 0, provider as any, makeConfig() as any, [],
        defaultLoopConfig,
      );

      // First addMessage call should be the assistant message with toolCalls
      expect(mockAddMessage).toHaveBeenCalled();
      const firstCall = mockAddMessage.mock.calls[0];
      expect(firstCall[1].role).toBe("assistant");
      expect(firstCall[1].toolCalls).toHaveLength(1);
      expect(firstCall[1].toolCalls[0].command).toBe("web_research");
    });

    it("saves text-only assistant message via deferred save", async () => {
      const provider = makeProvider([{ content: "Hello!" }]);

      await runTurnLoop(
        makeContext(), [], null, 0, provider as any, makeConfig() as any, [],
        defaultLoopConfig,
      );

      expect(mockAddMessage).toHaveBeenCalled();
      const [, msg, metadata] = mockAddMessage.mock.calls[0];
      expect(msg.role).toBe("assistant");
      expect(msg.content).toBe("Hello!");
      expect(metadata.source).toBe("assistant");
    });

    it("derives explorerRefs from the real tool result.data into persisted metadata", async () => {
      // Caller-level: refs are NOT injected into the sink — the turn batch
      // derives them from the dispatched tool's `result.data` (capture-shaped)
      // and threads them through to the persisted tool-result metadata.
      const provider = makeProvider([
        { toolCalls: [{ id: "call-1", name: "kyberswap_swap", arguments: {} }] },
        { content: "Done" },
      ]);
      mockDispatchTool.mockResolvedValue({
        success: true,
        output: '{"txHash":"0xabc"}',
        data: {
          txHash: "0xtop", // top-level hash is deliberately NOT paired
          _tradeCapture: { chain: "base", signature: "0xabc", walletAddress: "0xw" },
        },
      });

      await runTurnLoop(
        makeContext(), [], null, 0, provider as any, makeConfig() as any, [],
        defaultLoopConfig,
      );

      // The tool-result append (2nd addMessage call) carries the coherent ref.
      const toolResultCall = mockAddMessage.mock.calls.find(
        (c) => c[1]?.role === "tool",
      );
      expect(toolResultCall).toBeDefined();
      const metadata = toolResultCall![2] as { payload?: Record<string, unknown> };
      expect(metadata.payload?.explorerRefs).toEqual([
        { chain: "base", txRef: "0xabc" },
      ]);
    });

    it("saves assistant message BEFORE tool results (correct ordering)", async () => {
      const provider = makeProvider([
        { toolCalls: [{ id: "call-1", name: "web_research", arguments: { query: "test" } }] },
        { content: "Done" },
      ]);
      mockDispatchTool.mockResolvedValue({ success: true, output: '{"ok":true}' });

      await runTurnLoop(
        makeContext(), [], null, 0, provider as any, makeConfig() as any, [],
        defaultLoopConfig,
      );

      // Find the tool-call turn's messages (first two addMessage calls)
      const calls = mockAddMessage.mock.calls;
      // call[0] = assistant with toolCalls, call[1] = tool result
      expect(calls[0][1].role).toBe("assistant");
      expect(calls[1][1].role).toBe("tool");
      expect(calls[1][1].toolCallId).toBe("call-1");
    });
  });
});
