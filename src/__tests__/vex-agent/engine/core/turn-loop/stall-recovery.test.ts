/**
 * R-5: after an unproductive round the next inference call is a RECOVERY call
 * (a one-shot turn-state note plus, where the guard allows, low effort for
 * that call only), at most once per stall streak. Driven end to end through
 * `runTurnLoop` with a typed provider that records every request it receives.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type {
  InferenceConfig,
  InferenceProvider,
  ProviderMessage,
  ReasoningEffort,
  StreamChunk,
} from "@vex-agent/inference/types.js";
import type { Message } from "@vex-agent/db/repos/messages.js";
import type {
  InferenceAttemptRecord,
  ToolDispatchTimingRecord,
  TurnRunTimingRecord,
} from "@vex-agent/db/repos/runtime-timings.js";
import { fakeInferenceProvider } from "../../../../helpers/inference-provider.js";
import { requireValue } from "../../../../helpers/require-value.js";

// ── Mocks (same hermetic harness as iteration-and-save.test.ts) ──


const mockAddMessage = vi.fn();
const mockAddEngineMessage = vi.fn();
const mockGetLiveMessages = vi.fn().mockResolvedValue([]);
const mockGetOperatorInstructionsAfter = vi.fn().mockResolvedValue([]);
const mockDispatchTool = vi.fn();
const mockIncrementIterations = vi.fn().mockResolvedValue(1);
const mockUpdateStatus = vi.fn();
const mockSetLastCheckpoint = vi.fn();

// The turn loop registers a compaction-apply boundary action. Stubbed inert
// here: none of these tests exercise compaction, and the real module pulls the
// archive/messages graph these harnesses deliberately mock. The action's own
// behaviour lives in `turn-loop/compaction-apply-consumer.test.ts`.
// The turn loop's structured bound reporting (rule 05) is asserted below, so
// the logger is a real spy rather than a silent stub.
const mockLoggerWarn = vi.fn();
const mockLoggerInfo = vi.fn();
vi.mock("@utils/logger.js", () => ({
  default: {
    warn: (...a: unknown[]) => mockLoggerWarn(...a),
    error: vi.fn(),
    info: (...a: unknown[]) => mockLoggerInfo(...a),
    debug: vi.fn(),
  },
}));

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

// The recovery guard's one DB read. Scripted per test; defaults to "none".
const mockHasPendingForSession = vi
  .fn<(sessionId: string) => Promise<boolean>>()
  .mockResolvedValue(false);
vi.mock("@vex-agent/db/repos/approvals.js", () => ({
  enqueue: vi.fn(),
  enqueueWith: vi.fn(),
  hasPendingForSession: (sessionId: string) => mockHasPendingForSession(sessionId),
}));

// The R-5 switch, flippable per test. Read by the turn loop once per call.
const recoverySwitch = vi.hoisted(() => ({ enabled: true }));
vi.mock("@vex-agent/engine/core/runner/stall-recovery.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@vex-agent/engine/core/runner/stall-recovery.js")>();
  return {
    ...actual,
    get STALL_RECOVERY_ENABLED() {
      return recoverySwitch.enabled;
    },
  };
});

vi.mock("@vex-agent/db/repos/approval-intents.js", () => ({
  createWith: vi.fn(),
}));

vi.mock("@vex-agent/db/repos/usage.js", () => ({
  logUsage: vi.fn(),
}));

// Runtime-timing writes are captured, not executed (Kairos Phase 1). The
// thunk runs synchronously so each test can read the rows it produced.
const mockInsertTurnRunTiming = vi
  .fn<(record: TurnRunTimingRecord) => Promise<void>>()
  .mockResolvedValue(undefined);
const mockInsertInferenceAttempt = vi
  .fn<(record: InferenceAttemptRecord) => Promise<void>>()
  .mockResolvedValue(undefined);
const mockInsertToolDispatchTiming = vi
  .fn<(record: ToolDispatchTimingRecord) => Promise<void>>()
  .mockResolvedValue(undefined);
vi.mock("@vex-agent/db/repos/runtime-timings.js", () => ({
  insertTurnRunTiming: (record: TurnRunTimingRecord) => mockInsertTurnRunTiming(record),
  insertInferenceAttempt: (record: InferenceAttemptRecord) => mockInsertInferenceAttempt(record),
  insertToolDispatchTiming: (record: ToolDispatchTimingRecord) =>
    mockInsertToolDispatchTiming(record),
  recordInBackground: (_label: string, write: () => Promise<void>) => {
    void write();
  },
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


const { runTurnLoop } = await import("@vex-agent/engine/core/turn-loop.js");
const { MAX_CONSECUTIVE_UNPRODUCTIVE_ROUNDS } = await import(
  "@vex-agent/engine/core/runner/unproductive-rounds.js"
);
const { buildStallRecoveryNote } = await import("@vex-agent/engine/core/runner/stall-recovery.js");

const NOTE_HEADING = "# Last Attempt Produced No Action";

// ── Scripted rounds ─────────────────────────────────────────────

const blankRound: readonly StreamChunk[] = [{ type: "done", finishReason: "stop" }];
const exhaustedRound: readonly StreamChunk[] = [
  { type: "reasoning", reasoningText: "thinking until the limit" },
  { type: "done", finishReason: "length" },
];
const incompleteRound: readonly StreamChunk[] = [
  {
    type: "tool_call_delta",
    toolCallIndex: 0,
    toolCallId: "call-cut",
    toolCallName: "ToolSearch",
    toolCallArgsDelta: '{"query":"sw',
  },
  { type: "done", finishReason: "length" },
];
function textRound(text: string): readonly StreamChunk[] {
  return [{ type: "content", text }, { type: "done", finishReason: "stop" }];
}
function readToolRound(id: string): readonly StreamChunk[] {
  return [
    {
      type: "tool_call_delta",
      toolCallIndex: 0,
      toolCallId: id,
      toolCallName: "ToolSearch",
      toolCallArgsDelta: '{"query":"swap"}',
    },
    { type: "done", finishReason: "tool_calls" },
  ];
}

// ── Recording provider ──────────────────────────────────────────

interface SeenRequest {
  readonly turnState: string;
  readonly effort: ReasoningEffort | undefined;
  readonly history: string;
}

function recordingProvider(rounds: ReadonlyArray<readonly StreamChunk[]>): {
  readonly provider: InferenceProvider;
  readonly seen: SeenRequest[];
} {
  const seen: SeenRequest[] = [];
  let index = 0;
  const provider = fakeInferenceProvider({
    chatCompletionStream: async function* (
      messages: ProviderMessage[],
      _tools,
      config: InferenceConfig,
    ): AsyncGenerator<StreamChunk> {
      const turnState = messages.filter((m) => m.cacheHint === "turn_state");
      seen.push({
        turnState: turnState.map((m) => m.content).join("\n"),
        effort: config.reasoningEffort,
        history: JSON.stringify(messages.filter((m) => m.cacheHint !== "turn_state")),
      });
      const round = rounds[index] ?? rounds[rounds.length - 1] ?? blankRound;
      index += 1;
      for (const chunk of round) yield chunk;
    },
  });
  return { provider, seen };
}

function makeConfig(overrides: Partial<InferenceConfig> = {}): InferenceConfig {
  return {
    provider: "openrouter",
    model: "test-model",
    contextLimit: 128000,
    maxOutputTokens: 4096,
    inputPricePerM: 3,
    outputPricePerM: 15,
    priceCurrency: "USD",
    cachePricePerM: null,
    cacheWritePricePerM: null,
    reasoningPricePerM: null,
    supportsReasoningEffort: true,
    reasoningEffort: "high",
    ...overrides,
  };
}

function makeContext() {
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
  };
}

const loopConfig = { maxIterations: 50, timeoutMs: 60000, contextLimit: 128000 };

async function run(
  rounds: ReadonlyArray<readonly StreamChunk[]>,
  options: { config?: InferenceConfig; history?: Message[] } = {},
) {
  const { provider, seen } = recordingProvider(rounds);
  const result = await runTurnLoop(
    makeContext(), options.history ?? [], null, 0, provider, options.config ?? makeConfig(), [],
    loopConfig,
  );
  return { result, seen };
}

function infoCalls(event: string): unknown[] {
  return mockLoggerInfo.mock.calls.filter((c) => c[0] === event).map((c) => c[1]);
}

function seenAt(seen: readonly SeenRequest[], i: number): SeenRequest {
  return requireValue(seen[i]);
}

/** Everything the turn wrote to the transcript, as one string. */
function persistedText(): string {
  return JSON.stringify([...mockAddMessage.mock.calls, ...mockAddEngineMessage.mock.calls]);
}

function historyWith(toolName: string): Message[] {
  return [
    { role: "user", content: "go", timestamp: "2026-09-27T00:00:00.000Z" },
    {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "prev-1", command: toolName, args: {} }],
      timestamp: "2026-09-27T00:00:01.000Z",
    },
    { role: "tool", content: "{}", toolCallId: "prev-1", timestamp: "2026-09-27T00:00:02.000Z" },
  ];
}

describe("turn loop stall recovery (R-5)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    recoverySwitch.enabled = true;
    mockHasPendingForSession.mockResolvedValue(false);
    mockGetSessionForLoop.mockResolvedValue({ tokenCount: 0 });
    mockDispatchTool.mockResolvedValue({ success: true, output: '{"ok":true}', actionKind: "read" });
  });

  describe("each unproductive class arms one recovery for the NEXT request only", () => {
    it.each([
      ["blank", blankRound],
      ["reasoning_exhausted", exhaustedRound],
      ["incomplete_tool_batch", incompleteRound],
    ] as const)("%s", async (kind, failedRound) => {
      const { result, seen } = await run([failedRound, textRound("Done.")]);

      expect(seen).toHaveLength(2);
      const note = buildStallRecoveryNote(kind);
      expect(seenAt(seen, 0).turnState).not.toContain(NOTE_HEADING);
      expect(seenAt(seen, 1).turnState).toContain(note);
      // Turn state only: the note never enters the history segment.
      expect(seenAt(seen, 1).history).not.toContain(NOTE_HEADING);
      // Never persisted; only the answer row was written.
      expect(persistedText()).not.toContain(NOTE_HEADING);
      expect(mockAddMessage).toHaveBeenCalledTimes(1);
      expect(result.stopReason).toBe(null);
      expect(result.text).toBe("Done.");

      const logs = infoCalls("engine.turn.stall_recovery");
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatchObject({
        previousClassification: kind,
        iteration: 1,
        effortLowered: true,
        effortFrom: "high",
        effortTo: "low",
        guardReason: null,
      });
    });
  });

  it("the note is sanitised in the log: no note text, no arguments", async () => {
    await run([incompleteRound, textRound("Done.")]);
    const logged = JSON.stringify(mockLoggerInfo.mock.calls);
    expect(logged).not.toContain(NOTE_HEADING);
    expect(logged).not.toContain('{"query":"sw');
  });

  describe("effort is lowered for the recovery call only, and only when every guard passes", () => {
    it("all guards pass: the recovery request is low, the ones around it are not", async () => {
      const { seen } = await run([exhaustedRound, readToolRound("call-1"), textRound("Done.")]);
      expect(seen.map((s) => s.effort)).toEqual(["high", "low", "high"]);
      // The attempt row records the effort actually sent.
      const efforts = mockInsertInferenceAttempt.mock.calls.map((c) => c[0].requestedEffort);
      expect(efforts).toEqual(["high", "low", "high"]);
      expect(mockHasPendingForSession).toHaveBeenCalledWith("session-1");
    });

    it("pending approval: note only", async () => {
      mockHasPendingForSession.mockResolvedValue(true);
      const { seen } = await run([exhaustedRound, textRound("Done.")]);
      expect(seen.map((s) => s.effort)).toEqual(["high", "high"]);
      expect(seenAt(seen, 1).turnState).toContain(NOTE_HEADING);
      expect(infoCalls("engine.turn.stall_recovery")[0]).toMatchObject({
        effortLowered: false,
        guardReason: "pending_approval",
        effortFrom: "high",
        effortTo: "high",
      });
    });

    it("unreadable approval state: fails closed, note only", async () => {
      mockHasPendingForSession.mockRejectedValue(new Error("pool exhausted"));
      const { seen } = await run([exhaustedRound, textRound("Done.")]);
      expect(seen.map((s) => s.effort)).toEqual(["high", "high"]);
      expect(infoCalls("engine.turn.stall_recovery")[0]).toMatchObject({
        guardReason: "pending_approval_unreadable",
      });
    });

    it.each([
      ["a non-read tool", "SwapExecute"],
      ["an unregistered tool", "some_protocol.unknown_action"],
    ])("previous assistant call to %s: note only", async (_label, toolName) => {
      const { seen } = await run([exhaustedRound, textRound("Done.")], {
        history: historyWith(toolName),
      });
      expect(seen.map((s) => s.effort)).toEqual(["high", "high"]);
      expect(seenAt(seen, 1).turnState).toContain(NOTE_HEADING);
      expect(infoCalls("engine.turn.stall_recovery")[0]).toMatchObject({
        guardReason: "non_read_tool_call",
      });
      // Decided without touching the DB.
      expect(mockHasPendingForSession).not.toHaveBeenCalled();
    });

    it("previous assistant call to a read tool does not block lowering", async () => {
      const { seen } = await run([exhaustedRound, textRound("Done.")], {
        history: historyWith("ToolSearch"),
      });
      expect(seen.map((s) => s.effort)).toEqual(["high", "low"]);
    });

    it.each<[string, Partial<InferenceConfig>, ReasoningEffort | undefined, string]>([
      ["no explicit effort (provider default)", { reasoningEffort: undefined }, undefined, "effort_provider_default"],
      ["effort already low", { reasoningEffort: "low" }, "low", "effort_not_above_low"],
      ["model without the effort parameter", { supportsReasoningEffort: false }, "high", "effort_unsupported"],
    ])("%s: effort untouched, note still sent", async (_label, overrides, effort, reason) => {
      const { seen } = await run([blankRound, textRound("Done.")], { config: makeConfig(overrides) });
      expect(seen.map((s) => s.effort)).toEqual([effort, effort]);
      expect(seenAt(seen, 1).turnState).toContain(buildStallRecoveryNote("blank"));
      expect(infoCalls("engine.turn.stall_recovery")[0]).toMatchObject({
        effortLowered: false,
        guardReason: reason,
      });
      expect(mockHasPendingForSession).not.toHaveBeenCalled();
    });
  });

  it("a failed recovery ends the turn with no_progress instead of replaying the original request", async () => {
    const { result, seen } = await run([blankRound, exhaustedRound, blankRound, textRound("unreachable")]);

    expect(result.stopReason).toBe("no_progress");
    // The class of the round that ended the streak rides on the result so the
    // runner can pick the stop reply.
    expect(result.lastUnproductiveKind).toBe("reasoning_exhausted");
    // Original request, then the one recovery call; no third, identical request.
    expect(seen).toHaveLength(2);
    expect(seen.map((s) => s.turnState.includes(NOTE_HEADING))).toEqual([false, true]);
    expect(seen.map((s) => s.effort)).toEqual(["high", "low"]);
    expect(infoCalls("engine.turn.stall_recovery")).toHaveLength(1);
    expect(mockAddMessage).not.toHaveBeenCalled();
    expect(mockLoggerWarn.mock.calls.find((c) => c[0] === "engine.turn.no_progress_stop")?.[1]).toMatchObject({
      consecutiveUnproductiveRounds: 2,
      lastUnproductiveKind: "reasoning_exhausted",
    });
  });

  it("a productive round resets the streak, so a later stall recovers again", async () => {
    const { result, seen } = await run([
      blankRound,
      readToolRound("call-1"),
      exhaustedRound,
      textRound("Done."),
    ]);

    expect(result.text).toBe("Done.");
    expect(seen.map((s) => s.turnState.includes(NOTE_HEADING))).toEqual([false, true, false, true]);
    expect(seenAt(seen, 1).turnState).toContain(buildStallRecoveryNote("blank"));
    expect(seenAt(seen, 3).turnState).toContain(buildStallRecoveryNote("reasoning_exhausted"));
    expect(infoCalls("engine.turn.stall_recovery")).toHaveLength(2);
  });

  it("a recovered productive round proceeds normally: dispatched, persisted, no lingering note or effort", async () => {
    const { result, seen } = await run([
      exhaustedRound,
      readToolRound("call-1"),
      textRound("Done."),
    ]);

    expect(mockDispatchTool).toHaveBeenCalledTimes(1);
    expect(result.toolCallsMade).toBe(1);
    expect(result.text).toBe("Done.");
    expect(result.stopReason).toBe(null);
    expect(result.lastUnproductiveKind).toBeUndefined();
    const firstRow = requireValue(mockAddMessage.mock.calls[0])[1];
    expect(firstRow).toMatchObject({ role: "assistant" });
    expect(persistedText()).not.toContain(NOTE_HEADING);
    expect(seenAt(seen, 2).turnState).not.toContain(NOTE_HEADING);
    expect(seenAt(seen, 2).effort).toBe("high");
  });

  it("switched off: no note, no effort change, no approval read, same stall stop as before", async () => {
    recoverySwitch.enabled = false;
    const { result, seen } = await run([blankRound, exhaustedRound, blankRound, textRound("unreachable")]);

    expect(result.stopReason).toBe("no_progress");
    expect(seen).toHaveLength(MAX_CONSECUTIVE_UNPRODUCTIVE_ROUNDS);
    expect(seen.some((s) => s.turnState.includes(NOTE_HEADING))).toBe(false);
    expect(seen.map((s) => s.effort)).toEqual(["high", "high", "high"]);
    // Byte-identical requests: nothing about the replay differs any more.
    expect(seenAt(seen, 1).history).toBe(seenAt(seen, 0).history);
    expect(infoCalls("engine.turn.stall_recovery")).toHaveLength(0);
    expect(mockHasPendingForSession).not.toHaveBeenCalled();
  });
});
