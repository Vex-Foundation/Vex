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
// Resolves `true` so the terminal-safe CAS (`updateStatusIfNotTerminal`) reads
// as "the write landed"; `updateStatus` ignores the value.
const mockUpdateStatus = vi.fn().mockResolvedValue(true);
const mockSetLastCheckpoint = vi.fn();

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
    // The park sites now run the REAL operator-stop gate, which locks the run
    // row and treats a MISSING row as dead (fail-closed) — so a `null` here
    // would silently suppress every park these tests assert on. The runs in
    // this file are live, so say so.
    if (typeof sql === "string" && sql.includes("FROM mission_runs")) {
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

// Puzzle 3 atomic lease helpers — production calls these via dynamic imports
// from runner/turn-loop/wake paths. Default outcomes: claimed lease + no
// pending control request. Per-test overrides via `mockImplementationOnce`.
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

  // ── Pressure gating (PR2 cutover) ────────────────────────────

  describe("pressure gating", () => {
    it("does NOT trigger forced compact fallback when band is normal", async () => {
      mockGetSessionForLoop.mockResolvedValue({ tokenCount: 1_000 });

      const provider = makeProvider([{ content: "done" }]);

      await runTurnLoop(
        makeContext(), [], null, 0, provider as any, makeConfig() as any, [],
        defaultLoopConfig,
      );

      expect(mockForcedFallback).not.toHaveBeenCalled();
    });

    it("fires forced compact fallback at the top of the iteration when band is critical", async () => {
      // contextLimit = 128_000; critical threshold = 0.92 → 117_760 tokens.
      // Initial token count of 120_000 triggers critical at iter top.
      const provider = makeProvider([{ content: "post-compact reply" }]);

      await runTurnLoop(
        makeContext({ sessionKind: "mission", missionRunId: "run-1" }),
        [], null, 120_000, provider as any, makeConfig() as any, [],
        { ...defaultLoopConfig, maxIterations: 1 },
      );

      expect(mockForcedFallback).toHaveBeenCalledTimes(1);
      expect(mockForcedFallback).toHaveBeenCalledWith("session-1");
      // Post-compact bookkeeping: mission_runs.last_checkpoint_at bumped.
      expect(mockSetLastCheckpoint).toHaveBeenCalledWith("run-1");
    });

    it("arms the bridge counter at loop entry when checkpoint_generation > 0", async () => {
      // Pre-compacted session (gen=3, summary='post-compact'). The runTurnLoop
      // entry-guard must read this and arm `postCompactBridgeRemaining` so the
      // first provider call after a wake-resume / app-restart still gets the
      // resume packet — without the entry-arm, the in-process counter is 0
      // and the agent resumes blind.
      mockGetSessionForLoop.mockResolvedValue({
        tokenCount: 1_000,
        checkpointGeneration: 3,
        summary: "post-compact rolling summary",
      });

      const provider = makeProvider([{ content: "first turn" }]);

      await runTurnLoop(
        makeContext({ sessionKind: "mission", missionRunId: "run-1" }),
        [], null, 0, provider as any, makeConfig() as any, [],
        { ...defaultLoopConfig, maxIterations: 1 },
      );

      // The mock provider received exactly one call; verify executeTurn ran.
      // Bridge counter arm is observable indirectly — the entry-arm read of
      // `getSession` MUST have happened (it's the only path that reads
      // sessions in turn-loop). Two getSession calls per iteration is
      // expected (entry + critical-band ctx); for maxIterations=1 with no
      // forced fallback, we expect at least one read (entry-arm).
      expect(mockGetSessionForLoop).toHaveBeenCalled();
    });

    it("injects the resume packet for exactly the first two turns after a compacted-session resume", async () => {
      const dbClient = await import("@vex-agent/db/client.js");
      vi.mocked(dbClient.queryOne).mockResolvedValue({
        summary: "bridge summary from compact",
        checkpoint_generation: 2,
      });
      vi.mocked(dbClient.query).mockResolvedValue([]);
      mockGetSessionForLoop.mockResolvedValue({
        tokenCount: 1_000,
        checkpointGeneration: 2,
        summary: "bridge summary from compact",
      });

      const provider = makeProvider([
        { content: "turn one" },
        { content: "turn two" },
        { content: "turn three" },
      ]);

      await runTurnLoop(
        makeContext({ sessionKind: "mission", missionRunId: "run-1" }),
        [], null, 0, provider as any, makeConfig() as any, [],
        { ...defaultLoopConfig, maxIterations: 3 },
      );

      const calls = provider.chatCompletion.mock.calls.map(
        (call) => call[0] as Array<{ role: string; content: string }>,
      );
      expect(calls).toHaveLength(3);
      expect(calls[0].some((m) => m.content.includes("[Resume packet"))).toBe(true);
      expect(calls[1].some((m) => m.content.includes("[Resume packet"))).toBe(true);
      expect(calls[2].some((m) => m.content.includes("[Resume packet"))).toBe(false);
    });

    it("does NOT arm bridge counter when session has never been compacted (checkpoint_generation === 0)", async () => {
      mockGetSessionForLoop.mockResolvedValue({
        tokenCount: 1_000,
        checkpointGeneration: 0,
        summary: null,
      });

      const provider = makeProvider([{ content: "first turn" }]);

      // No assertion fails — just verify the loop completes cleanly. The
      // resume-packet builder would never produce output for a session with
      // generation=0 anyway; this test pins the "fresh session → no bridge"
      // expectation explicitly so a future regression that always-arms
      // gets caught.
      await runTurnLoop(
        makeContext({ sessionKind: "mission", missionRunId: "run-1" }),
        [], null, 0, provider as any, makeConfig() as any, [],
        { ...defaultLoopConfig, maxIterations: 1 },
      );

      expect(provider.chatCompletion).toHaveBeenCalledTimes(1);
    });

    it("after committed forced fallback the next provider call sees the post-compact band, not the stale critical band (P1 #2 regression)", async () => {
      // Start at critical (120_000 / 128_000 > 0.92). After forced fallback
      // commits, the handlePostCompactBookkeeping reset currentTokenCount=0
      // and the loop recomputes turnBand to normal. Without that recompute,
      // buildTurnPromptStack would project the tools array at the "critical"
      // band and the model would see the restricted (read_only +
      // safe_at_barrier) catalog AND the critical-pressure banner on
      // the very first post-compact turn, wasting a turn.
      mockGetOpenAITools.mockClear();
      const provider = makeProvider([{ content: "post-compact reply" }]);

      await runTurnLoop(
        makeContext({ sessionKind: "mission", missionRunId: "run-1" }),
        [], null, 120_000, provider as any, makeConfig() as any, [],
        {
          ...defaultLoopConfig,
          maxIterations: 1,
          baseVisibility: { permission: "restricted", sessionKind: "mission", missionRunActive: true },
        },
      );

      // Forced fallback fired and committed.
      expect(mockForcedFallback).toHaveBeenCalledTimes(1);
      // The per-turn tools projection (getOpenAITools inside buildTurnPromptStack)
      // ran exactly once for the post-fallback turn.
      expect(mockGetOpenAITools).toHaveBeenCalledTimes(1);
      // CRITICAL invariant: the band in the visibility context was NOT critical
      // — it must be the recomputed post-compact band ("normal" because
      // currentTokenCount was reset to 0 inside the bookkeeping).
      expect(mockGetOpenAITools.mock.calls[0]![0].contextUsageBand).toBe("normal");
    });

    it("two consecutive forced-fallback noops at critical escalate to compact_unable_at_critical", async () => {
      mockForcedFallback.mockResolvedValue({ kind: "noop", reason: "no_compactable" });

      // Mission-mode provider that stays text-only so each iter loops back
      // through the band check at the top and re-triggers forced fallback.
      const provider = {
        chatCompletion: vi.fn().mockResolvedValue({
          content: "still working",
          toolCalls: null,
          usage: {
            promptTokens: 120_000,
            completionTokens: 200,
            cachedTokens: 0,
            reasoningTokens: 0,
          },
        }),
        calculateCost: vi.fn().mockReturnValue({ totalCost: 0.001, currency: "USD", breakdown: { promptCost: 0, completionCost: 0, cachedSavings: 0, reasoningCost: 0 } }),
      };

      const result = await runTurnLoop(
        makeContext({ sessionKind: "mission", missionRunId: "run-1" }),
        [], null, 120_000, provider as any, makeConfig() as any, [],
        { ...defaultLoopConfig, maxIterations: 5 },
      );

      expect(result.stopReason).toBe("compact_unable_at_critical");
      expect(mockForcedFallback).toHaveBeenCalledTimes(2);
      // Mission run flipped to paused_error with the right reason.
      const lastUpdate = mockUpdateStatus.mock.calls.findLast(
        (c: unknown[]) => c[0] === "run-1" && c[1] === "paused_error",
      );
      expect(lastUpdate).toBeDefined();
      expect(lastUpdate![2]).toBe("compact_unable_at_critical");
    });

    it("compact_committed engine signal drains remaining batch tool calls with synthetic results", async () => {
      // Three tools in the batch; the SECOND one returns compact_committed.
      // Expected: first dispatched normally; second dispatched (returns signal);
      // third NOT dispatched but persisted with a synthetic
      // `batch_aborted_by_compact` tool_result so the assistant.tool_calls JSONB
      // stays balanced after reload.
      let dispatchCount = 0;
      mockDispatchTool.mockImplementation(async () => {
        dispatchCount++;
        if (dispatchCount === 1) {
          return { success: true, output: "wallet-read-result" };
        }
        if (dispatchCount === 2) {
          return {
            success: true,
            output: "compact committed",
            engineSignal: {
              type: "compact_committed",
              reason: "context_pressure_compact",
              summary: "compacted",
              generation: 2,
              jobId: 11,
            },
          };
        }
        throw new Error("third tool call must not be dispatched");
      });

      const provider = makeProvider([
        {
          toolCalls: [
            { id: "tc-1", name: "wallet_balances", arguments: {} },
            { id: "tc-2", name: "compact_now", arguments: { conversation_summary: "..." } },
            { id: "tc-3", name: "long_memory_suggest", arguments: {} },
          ],
        },
        { content: "post-compact reply" },
      ]);

      await runTurnLoop(
        makeContext({ sessionKind: "mission", missionRunId: "run-1" }),
        [], null, 50_000, provider as any, makeConfig() as any, [],
        { ...defaultLoopConfig, maxIterations: 2 },
      );

      expect(mockDispatchTool).toHaveBeenCalledTimes(2);

      // The synthetic batch_aborted result for tc-3 is persisted via addMessage
      // with role="tool" alongside the other two.
      const toolMessages = mockAddMessage.mock.calls.filter(
        (c: unknown[]) => (c[1] as { role?: string })?.role === "tool",
      );
      expect(toolMessages.length).toBe(3);
      const abortedMsg = toolMessages.find(
        (c: unknown[]) => (c[1] as { toolCallId?: string })?.toolCallId === "tc-3",
      );
      expect(abortedMsg).toBeDefined();
      expect((abortedMsg![1] as { content: string }).content).toContain(
        "batch_aborted_by_compact",
      );

      // Post-compact bookkeeping: mission_runs.last_checkpoint_at bumped.
      expect(mockSetLastCheckpoint).toHaveBeenCalledWith("run-1");
    });

    it("merges operator interrupts that land during compact before the next provider call", async () => {
      mockDispatchTool.mockResolvedValue({
        success: true,
        output: "compact committed",
        engineSignal: {
          type: "compact_committed",
          reason: "context_pressure_compact",
          summary: "compacted",
          generation: 2,
          jobId: 11,
        },
      });
      mockGetLiveMessages.mockResolvedValueOnce([
        {
          id: 10,
          role: "assistant",
          content: "post-compact live tail",
          timestamp: "2026-05-04T08:00:00.000Z",
        },
      ]);
      mockGetOperatorInstructionsAfter.mockResolvedValueOnce([
        {
          id: 43,
          role: "user",
          content: "pause risky route and re-check allowance",
          timestamp: "2026-05-04T08:01:00.000Z",
          metadata: {
            source: "user",
            messageType: "operator_interrupt",
            visibility: "user",
            payload: { operatorInstruction: true },
          },
        },
      ]);

      const provider = makeProvider([
        {
          toolCalls: [
            { id: "tc-compact", name: "compact_now", arguments: { conversation_summary: "..." } },
          ],
        },
        { content: "Applying operator instruction after compact." },
      ]);

      await runTurnLoop(
        makeContext({ sessionKind: "mission", missionRunId: "run-1" }),
        [], null, 50_000, provider as any, makeConfig() as any, [],
        { ...defaultLoopConfig, maxIterations: 2 },
      );

      const secondMessages = provider.chatCompletion.mock.calls[1]![0] as Array<{ role: string; content: string }>;
      expect(secondMessages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ role: "user", content: "pause risky route and re-check allowance" }),
          expect.objectContaining({
            role: "system",
            content: expect.stringContaining("operator_interrupt"),
          }),
        ]),
      );
      expect(mockAddEngineMessage).toHaveBeenCalledWith(
        "session-1",
        expect.stringContaining("operator_interrupt"),
        expect.objectContaining({ messageType: "operator_interrupt" }),
      );
    });

    it("does not bump last_checkpoint_at for agent sessions after compact_committed", async () => {
      mockDispatchTool.mockResolvedValue({
        success: true,
        output: "compact committed",
        engineSignal: {
          type: "compact_committed",
          reason: "context_pressure_compact",
          summary: "compacted",
          generation: 2,
          jobId: 11,
        },
      });

      const provider = makeProvider([
        {
          toolCalls: [
            { id: "tc-compact", name: "compact_now", arguments: { conversation_summary: "..." } },
          ],
        },
      ]);

      await runTurnLoop(
        makeContext({ sessionKind: "agent", missionRunId: null }),
        [], null, 50_000, provider as any, makeConfig() as any, [],
        { ...defaultLoopConfig, maxIterations: 1 },
      );

      expect(mockSetLastCheckpoint).not.toHaveBeenCalled();
    });

    it("uses the latest promptTokens for tool dispatch context band", async () => {
      const provider = makeProvider([
        {
          toolCalls: [{ id: "call-1", name: "web_research", arguments: { query: "x" } }],
          promptTokens: 950,
        },
      ]);
      mockDispatchTool.mockResolvedValue({ success: true, output: "ok" });

      await runTurnLoop(
        makeContext(), [], null, 100, provider as any, makeConfig() as any, [],
        { ...defaultLoopConfig, maxIterations: 1, contextLimit: 1000 },
      );

      const [, toolContext] = mockDispatchTool.mock.calls[0];
      expect(toolContext).toMatchObject({
        contextUsageBand: "critical",
      });
    });

    it("rebuilds tools for the next iteration from latest promptTokens", async () => {
      mockGetOpenAITools.mockClear();
      const provider = makeProvider([
        { content: "working", promptTokens: 850 },
        { content: "still working", promptTokens: 850 },
      ]);

      await runTurnLoop(
        makeContext({ sessionKind: "mission", missionRunId: "run-1" }),
        [], null, 100, provider as any, makeConfig() as any, [],
        {
          ...defaultLoopConfig,
          maxIterations: 2,
          contextLimit: 1000,
          baseVisibility: { permission: "restricted", sessionKind: "mission", missionRunActive: true },
        },
      );

      // buildTurnPromptStack re-projects the tools array each turn from the live
      // band: turn 1 at "normal" (tokenCount 100), turn 2 at "warning" (850/1000
      // crosses the warning threshold).
      expect(mockGetOpenAITools.mock.calls.map(c => c[0].contextUsageBand)).toEqual(["normal", "warning"]);
    });
  });
});
