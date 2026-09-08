/**
 * The turn loop CONSUMING the compaction-apply boundary outcomes.
 *
 * The iteration-entry seam PRODUCES `compaction_applied` /
 * `compaction_apply_deferred`; until the apply package existed there was no
 * producer, so the consumer side was a named gap. This file closes it.
 *
 * Three properties, each a defect if broken:
 *
 *   1. A DEFERRAL NEVER COUNTS AS A NOOP. `criticalNoopCounter` escalates a run
 *      to `paused_error` after repeated fruitless critical iterations. Deferring
 *      for a queued stop or in-flight money is the gate WORKING, and counting it
 *      would park a healthy run for waiting correctly.
 *
 *   2. NEITHER OUTCOME SKIPS THE TURN. Both fall through and the iteration runs
 *      its inference. This is the subtle one: a deferral repeats for as long as
 *      the money state is unresolved, and that state usually clears only BECAUSE
 *      the agent keeps running (an approval dispatches, a broadcast confirms).
 *      A loop that skipped the turn on every deferral would spin to
 *      `iteration_limit` waiting for something only the skipped turn could
 *      cause.
 *
 *   3. AN APPLY RUNS POST-COMPACT BOOKKEEPING before the turn, so the turn plans
 *      against the compacted transcript rather than the stale one the loop was
 *      holding.
 *
 * The seam itself is mocked here so the outcomes can be produced exactly; the
 * seam's own ordering contract is covered by
 * `turn-loop-iteration-entry-actions.test.ts`.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { COMPACT_MAX_CONSECUTIVE_NOOPS } from "@vex-agent/engine/core/turn-loop-critical-fallback.js";
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


// The apply package. The turn loop registers its boundary action; the seam is
// mocked below, so this only has to exist as a well-formed action.
vi.mock("@vex-agent/engine/compaction/apply/index.js", () => ({
  createCompactionApplyAction: () => ({
    name: "compaction_apply",
    phase: "apply" as const,
    run: async () => ({ kind: "continue" as const }),
  }),
}));

// The seam — mocked so each test can produce an exact iteration outcome.
const mockRunIterationEntryGuards = vi.fn(async () => ({ kind: "proceed" as const }));
vi.mock("@vex-agent/engine/core/turn-loop-iteration-entry.js", () => ({
  runIterationEntryGuards: (...a: unknown[]) => mockRunIterationEntryGuards(...(a as [])),
}));

const { runTurnLoop } = await import("../../../../../vex-agent/engine/core/turn-loop.js");

describe("turn-loop — compaction apply consumer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSessionForLoop.mockResolvedValue({ tokenCount: 0 });
    mockRunIterationEntryGuards.mockResolvedValue({ kind: "proceed" } as never);
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


  // ── Compaction-apply boundary outcomes ───────────────────────

  describe("compaction apply outcomes", () => {
    /** Produce `outcome` on the first iteration, then let the loop proceed. */
    function entryOnce(outcome: Record<string, unknown>): void {
      mockRunIterationEntryGuards
        .mockResolvedValueOnce(outcome as never)
        .mockResolvedValue({ kind: "proceed" } as never);
    }

    it("EVERY deferring iteration still runs its turn — the loop must not spin", async () => {
      // Property 2, asserted so it CANNOT pass vacuously: the seam defers on
      // every single iteration. If the loop skipped the turn on a deferral, no
      // inference would ever run and the loop would spin to `iteration_limit`
      // waiting for money state that only a running turn can resolve.
      mockRunIterationEntryGuards.mockResolvedValue({
        kind: "compaction_apply_deferred",
        reasons: [{ kind: "wallet_intent_live", ref: "intent-1" }],
      } as never);
      const provider = makeProvider([{ content: "done" }]);

      const result = await runTurnLoop(
        makeContext(), [], null, 0, provider as any, makeConfig() as any, [],
        defaultLoopConfig,
      );

      expect(provider.chatCompletion).toHaveBeenCalledTimes(1);
      expect(result.stopReason).toBeNull();
    });

    it("a deferral does NOT count toward criticalNoopCounter (exact escalation point)", async () => {
      // Property 1, asserted by COUNTING. In the critical band with a forced
      // fallback that keeps returning `noop`, the run escalates after exactly
      // COMPACT_MAX_CONSECUTIVE_NOOPS such iterations — and every one of those
      // iterations also defers an apply.
      //
      // If a deferral ALSO incremented the counter, escalation would arrive in
      // half the iterations and fewer turns would have run. Asserting the exact
      // number of turns is what makes that difference visible.
      mockRunIterationEntryGuards.mockResolvedValue({
        kind: "compaction_apply_deferred",
        reasons: [{ kind: "approval_in_flight", ref: "appr-1" }],
      } as never);
      mockGetSessionForLoop.mockResolvedValue({ tokenCount: 125_000 });
      mockForcedFallback.mockResolvedValue({ kind: "noop", reason: "no_compactable" });
      // Every turn comes back still critical, so the band — and the counter —
      // survive across iterations instead of resetting after the first turn.
      const provider = makeProvider([
        { content: "Checking the pending approval.", toolCalls: [], promptTokens: 125_000 },
      ]);

      const result = await runTurnLoop(
        // The loop's band comes from the token count it is STARTED with.
        makeContext({ sessionKind: "mission", missionRunId: "run-1" }), [], null, 125_000,
        provider as any, makeConfig() as any, [],
        { ...defaultLoopConfig, maxIterations: 20 },
      );

      expect(result.stopReason).toBe("compact_unable_at_critical");
      // One turn per pre-escalation iteration: the counter reached the
      // threshold on the LAST one, which escalates before running a turn.
      expect(provider.chatCompletion).toHaveBeenCalledTimes(
        COMPACT_MAX_CONSECUTIVE_NOOPS - 1,
      );
    });

    it("an APPLY runs post-compact bookkeeping BEFORE the turn", async () => {
      // Property 3: the loop re-reads the compacted session, so the turn plans
      // against the new transcript. `getSessionForLoop` is what bookkeeping
      // re-reads; the turn then runs.
      entryOnce({
        kind: "compaction_applied",
        generation: 4,
        archivedMessages: 12,
      });
      mockGetLiveMessages.mockResolvedValue([]);
      const provider = makeProvider([{ content: "done" }]);

      await runTurnLoop(
        makeContext(), [], null, 0, provider as any, makeConfig() as any, [],
        defaultLoopConfig,
      );

      expect(mockGetSessionForLoop).toHaveBeenCalled();
      expect(provider.chatCompletion).toHaveBeenCalledTimes(1);
    });

    it("a stop outcome from the seam still wins over everything", async () => {
      // The guard order is the seam's contract, but the CONSUMER must honour a
      // stop by breaking out — never running a turn on a stopped session.
      mockRunIterationEntryGuards.mockResolvedValue({
        kind: "abort_user_stopped",
      } as never);
      const provider = makeProvider([{ content: "done" }]);

      const result = await runTurnLoop(
        makeContext(), [], null, 0, provider as any, makeConfig() as any, [],
        defaultLoopConfig,
      );

      expect(provider.chatCompletion).not.toHaveBeenCalled();
      expect(result.stopReason).toBe("user_stopped");
    });
  });
});
