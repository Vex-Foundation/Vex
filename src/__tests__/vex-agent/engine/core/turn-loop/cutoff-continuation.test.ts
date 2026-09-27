/**
 * R-9: a text answer the output limit cut short is held back and finished by
 * ONE continuation call (the fragment as the last assistant message plus a
 * one-shot turn-state note), then saved as ONE assistant row - or saved with a
 * visible marker when it still is not complete. Driven end to end through
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
import type { BoardSpecV1 } from "../../../../../lib/board/index.js";
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
  toStreamAbortedEvent: vi.fn(),
}));

// Scripted inference-bound stops: the REAL `runStreamingInference` runs, then
// the chosen call is reported as timed out, shaped as the contract returns it.
const timeoutScript = vi.hoisted(() => ({ byCall: new Set<number>(), calls: 0 }));
vi.mock("@vex-agent/inference/stream-consumer.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@vex-agent/inference/stream-consumer.js")>();
  return {
    ...actual,
    runStreamingInference: async (
      ...args: Parameters<typeof actual.runStreamingInference>
    ): ReturnType<typeof actual.runStreamingInference> => {
      const call = timeoutScript.calls;
      timeoutScript.calls += 1;
      const result = await actual.runStreamingInference(...args);
      if (!timeoutScript.byCall.has(call)) return result;
      return {
        response: { ...result.response, toolCalls: null, finishReason: null, malformedToolCallCount: 0 },
        aborted: false,
        usageObserved: result.usageObserved,
        timedOut: "idle",
      };
    },
  };
});

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

// The R-9 switch, flippable per test. Read by the turn loop on every text round.
const cutoffSwitch = vi.hoisted(() => ({ enabled: true }));
vi.mock("@vex-agent/engine/core/runner/cutoff-continuation.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@vex-agent/engine/core/runner/cutoff-continuation.js")>();
  return {
    ...actual,
    get CUTOFF_CONTINUATION_ENABLED() {
      return cutoffSwitch.enabled;
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
const { CUTOFF_CONTINUATION_NOTE, CUTOFF_ANSWER_SUFFIX } = await import(
  "@vex-agent/engine/core/runner/cutoff-continuation.js"
);
const { stagePresentation } = await import("@vex-agent/engine/core/board-presentation.js");
const { buildStallRecoveryNote } = await import("@vex-agent/engine/core/runner/stall-recovery.js");

const NOTE_HEADING = "# Previous Answer Cut Off";
const SESSION_ID = "session-1";

// ── Scripted rounds ─────────────────────────────────────────────

const blankRound: readonly StreamChunk[] = [{ type: "done", finishReason: "stop" }];
function textRound(text: string): readonly StreamChunk[] {
  return [{ type: "content", text }, { type: "done", finishReason: "stop" }];
}
function cutRound(text: string, reasoning?: string): readonly StreamChunk[] {
  return [
    ...(reasoning === undefined ? [] : [{ type: "reasoning" as const, reasoningText: reasoning }]),
    { type: "content", text },
    { type: "done", finishReason: "length" },
  ];
}
function readToolRound(id: string, finishReason = "tool_calls"): readonly StreamChunk[] {
  return [
    {
      type: "tool_call_delta",
      toolCallIndex: 0,
      toolCallId: id,
      toolCallName: "ToolSearch",
      toolCallArgsDelta: '{"query":"swap"}',
    },
    { type: "done", finishReason },
  ];
}
/** Two complete read calls; `finishReason` decides whether the batch finished. */
function twoReadToolsRound(finishReason: string): readonly StreamChunk[] {
  return [
    {
      type: "tool_call_delta",
      toolCallIndex: 0,
      toolCallId: "call-a",
      toolCallName: "ToolSearch",
      toolCallArgsDelta: '{"query":"swap"}',
    },
    {
      type: "tool_call_delta",
      toolCallIndex: 1,
      toolCallId: "call-b",
      toolCallName: "ToolSearch",
      toolCallArgsDelta: '{"query":"bridge"}',
    },
    { type: "done", finishReason },
  ];
}
/** A tool call the output limit cut off mid-arguments: an incomplete batch. */
const truncatedToolRound: readonly StreamChunk[] = [
  { type: "content", text: "Let me look that up" },
  {
    type: "tool_call_delta",
    toolCallIndex: 0,
    toolCallId: "call-cut",
    toolCallName: "ToolSearch",
    toolCallArgsDelta: '{"query":"sw',
  },
  { type: "done", finishReason: "length" },
];

// ── Recording provider ──────────────────────────────────────────

interface SeenRequest {
  readonly turnState: string;
  readonly effort: ReasoningEffort | undefined;
  readonly history: readonly ProviderMessage[];
}

/**
 * `onRound(i)` runs as round `i` starts streaming - the hook a test uses to
 * stage a board or trip a Stop at a precise point in the turn.
 */
function recordingProvider(
  rounds: ReadonlyArray<readonly StreamChunk[]>,
  onRound: (index: number) => void = () => {},
): { readonly provider: InferenceProvider; readonly seen: SeenRequest[] } {
  const seen: SeenRequest[] = [];
  let index = 0;
  const provider = fakeInferenceProvider({
    chatCompletionStream: async function* (
      messages: ProviderMessage[],
      _tools,
      config: InferenceConfig,
    ): AsyncGenerator<StreamChunk> {
      seen.push({
        turnState: messages
          .filter((m) => m.cacheHint === "turn_state")
          .map((m) => m.content)
          .join("\n"),
        effort: config.reasoningEffort,
        history: messages.filter((m) => m.cacheHint !== "turn_state"),
      });
      const round = rounds[index] ?? rounds[rounds.length - 1] ?? blankRound;
      onRound(index);
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

function makeContext(missionRunId: string | null = null) {
  return {
    sessionId: SESSION_ID,
    sessionKind: missionRunId === null ? ("agent" as const) : ("mission" as const),
    sessionPermission: "restricted" as const,
    missionId: missionRunId === null ? null : "mission-1",
    missionRunId,
    selectedEvmWallet: null,
    selectedSolanaWallet: null,
    walletPolicy: { kind: "none" as const },
    loadedDocuments: new Map<string, string>(),
  };
}

async function run(
  rounds: ReadonlyArray<readonly StreamChunk[]>,
  options: {
    missionRunId?: string | null;
    maxIterations?: number;
    onRound?: (index: number) => void;
  } = {},
) {
  const { provider, seen } = recordingProvider(rounds, options.onRound);
  const result = await runTurnLoop(
    makeContext(options.missionRunId ?? null), [], null, 0, provider, makeConfig(), [],
    { maxIterations: options.maxIterations ?? 50, timeoutMs: 60000, contextLimit: 128000 },
  );
  return { result, seen };
}

function seenAt(seen: readonly SeenRequest[], i: number): SeenRequest {
  return requireValue(seen[i]);
}

interface SavedRow {
  readonly role: string;
  readonly content: string;
  readonly toolCalls: readonly unknown[] | undefined;
  readonly messageType: string | undefined;
  readonly board: BoardSpecV1 | undefined;
  readonly reasoning: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isBoardSpec(value: unknown): value is BoardSpecV1 {
  return isRecord(value) && value["version"] === 1 && typeof value["title"] === "string";
}

/** Every assistant row the turn wrote, in order, read off the transcript boundary (tool rows skipped). */
function savedRows(): SavedRow[] {
  return mockAddMessage.mock.calls.map((call: unknown[]) => {
    const message: unknown = call[1];
    const metadata: unknown = call[2];
    if (!isRecord(message)) throw new Error("row without a message");
    const payload = isRecord(metadata) && isRecord(metadata["payload"]) ? metadata["payload"] : {};
    const toolCalls = message["toolCalls"];
    const board = payload["board"];
    return {
      role: String(message["role"]),
      content: String(message["content"]),
      toolCalls: Array.isArray(toolCalls) ? toolCalls : undefined,
      messageType: isRecord(metadata) && typeof metadata["messageType"] === "string"
        ? metadata["messageType"]
        : undefined,
      board: isBoardSpec(board) ? board : undefined,
      reasoning: payload["reasoning"],
    };
  }).filter((row) => row.role === "assistant");
}

function onlyRow(): SavedRow {
  const rows = savedRows();
  expect(rows).toHaveLength(1);
  return requireValue(rows[0]);
}

function infoCalls(event: string): unknown[] {
  return mockLoggerInfo.mock.calls.filter((c) => c[0] === event).map((c) => c[1]);
}

function warnCalls(event: string): unknown[] {
  return mockLoggerWarn.mock.calls.filter((c) => c[0] === event).map((c) => c[1]);
}

function boardSpec(title: string): BoardSpecV1 {
  return {
    version: 1,
    title,
    pools: [{ chain: "solana", pairAddress: "Abc123", analysis: null }],
    hydration: {
      rows: [],
      candles: null,
      unmatchedMarkerAtMs: null,
      analysisCreatedAt: 1_700_000_000_000,
      marketDataFetchedAt: 1_700_000_000_000,
      provenance: { transport: "site_bridge", sourceObservation: "0 pool rows" },
      staleAfterMs: 60_000,
    },
  };
}

describe("turn loop cut-off answer continuation (R-9)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    timeoutScript.byCall.clear();
    timeoutScript.calls = 0;
    cutoffSwitch.enabled = true;
    mockHasPendingForSession.mockResolvedValue(false);
    mockGetSessionForLoop.mockResolvedValue({ tokenCount: 0 });
    mockDispatchTool.mockResolvedValue({ success: true, output: '{"ok":true}', actionKind: "read" });
  });

  it("continues once and saves ONE row with the fragment and the continuation joined", async () => {
    const { result, seen } = await run([
      cutRound("The pool is deep and the spr", "first thoughts"),
      [
        { type: "reasoning", reasoningText: "second thoughts" },
        { type: "content", text: "ead is tight." },
        { type: "done", finishReason: "stop" },
      ],
    ]);

    expect(seen).toHaveLength(2);
    // The first request is ordinary; the continuation carries the note and the
    // fragment as its LAST message, and nothing else is different.
    expect(seenAt(seen, 0).turnState).not.toContain(NOTE_HEADING);
    expect(seenAt(seen, 1).turnState).toContain(CUTOFF_CONTINUATION_NOTE);
    expect(seenAt(seen, 1).history.at(-1)).toMatchObject({
      role: "assistant",
      content: "The pool is deep and the spr",
    });
    expect(seenAt(seen, 0).history.some((m) => m.content === "The pool is deep and the spr")).toBe(false);
    // Never a lowered effort for a continuation.
    expect(seen.map((s) => s.effort)).toEqual(["high", "high"]);

    const row = onlyRow();
    expect(row).toMatchObject({
      role: "assistant",
      content: "The pool is deep and the spread is tight.",
      messageType: "chat",
    });
    expect(row.reasoning).toBe("first thoughts\n\nsecond thoughts");
    expect(result.text).toBe("The pool is deep and the spread is tight.");
    expect(result.stopReason).toBe(null);
    // The note is never persisted anywhere.
    expect(JSON.stringify(mockAddMessage.mock.calls)).not.toContain(NOTE_HEADING);
    expect(JSON.stringify(mockAddEngineMessage.mock.calls)).not.toContain(NOTE_HEADING);
    expect(infoCalls("engine.turn.cutoff_continuation_resolved")[0]).toMatchObject({
      outcome: "completed",
    });
  });

  it("the continuation counts as an iteration", async () => {
    const { result } = await run([cutRound("Half an ans"), textRound("wer.")]);
    expect(result.text).toBe("Half an answer.");
    const timing = requireValue(mockInsertTurnRunTiming.mock.calls[0])[0];
    expect(timing.iterations).toBe(2);
  });

  it("a continuation cut off again is saved once, joined, with the visible marker, and not continued again", async () => {
    const { result, seen } = await run([cutRound("Part one, "), cutRound("part two"), textRound("unreachable")]);

    expect(seen).toHaveLength(2);
    expect(onlyRow().content).toBe(`Part one, part two${CUTOFF_ANSWER_SUFFIX}`);
    expect(CUTOFF_ANSWER_SUFFIX).toBe("\n\n_(Answer cut off at the output limit.)_");
    expect(result.text).toBe(`Part one, part two${CUTOFF_ANSWER_SUFFIX}`);
    expect(infoCalls("engine.turn.cutoff_continuation_resolved")[0]).toMatchObject({
      outcome: "still_cut_off",
    });
  });

  it("a continuation whose stream ends with no finish signal is saved joined but marked, not as complete", async () => {
    const { result, seen } = await run([
      cutRound("Consensus is sub"),
      [{ type: "content", text: "tle and the stream just stops" }],
      textRound("unreachable"),
    ]);

    expect(seen).toHaveLength(2);
    expect(onlyRow().content).toBe(`Consensus is subtle and the stream just stops${CUTOFF_ANSWER_SUFFIX}`);
    expect(result.text).toBe(`Consensus is subtle and the stream just stops${CUTOFF_ANSWER_SUFFIX}`);
    expect(infoCalls("engine.turn.cutoff_continuation_resolved")[0]).toMatchObject({
      outcome: "ambiguous_end",
      finishReason: null,
    });
  });

  it.each<[string, readonly StreamChunk[]]>([
    ["blank", blankRound],
    ["reasoning-only", [
      { type: "reasoning", reasoningText: "hmm" },
      { type: "done", finishReason: "length" },
    ]],
  ])("an unproductive (%s) continuation saves the fragment with the marker, not a stall", async (_label, round) => {
    const { result, seen } = await run([cutRound("Only this much"), round, textRound("unreachable")]);

    expect(seen).toHaveLength(2);
    expect(onlyRow().content).toBe(`Only this much${CUTOFF_ANSWER_SUFFIX}`);
    expect(result.stopReason).toBe(null);
    // Not treated as a stall: no recovery note was ever sent.
    expect(seen.some((s) => s.turnState.includes("# Last Attempt Produced No Action"))).toBe(false);
  });

  it("a continuation stopped by an inference bound saves only the fragment, marked", async () => {
    timeoutScript.byCall.add(1);
    const { result, seen } = await run([cutRound("Before the stall"), textRound(" NEVER SAVED"), textRound("unreachable")]);

    expect(seen).toHaveLength(2);
    expect(onlyRow().content).toBe(`Before the stall${CUTOFF_ANSWER_SUFFIX}`);
    expect(JSON.stringify(mockAddMessage.mock.calls)).not.toContain("NEVER SAVED");
    expect(result.stopReason).toBe(null);
    expect(infoCalls("engine.turn.cutoff_continuation_resolved")[0]).toMatchObject({ outcome: "timed_out" });
  });

  it("a timed-out first round is a stall, never a cut-off answer", async () => {
    timeoutScript.byCall.add(0);
    const { seen } = await run([cutRound("Half"), textRound("Done.")]);

    expect(seen).toHaveLength(2);
    expect(seenAt(seen, 1).turnState).not.toContain(NOTE_HEADING);
    expect(seenAt(seen, 1).turnState).toContain(buildStallRecoveryNote("stream_timeout"));
    expect(savedRows().map((r) => r.content)).toEqual(["Done."]);
  });

  it("a continuation that calls tools saves the marked fragment first, then runs the round normally", async () => {
    const { result, seen } = await run([cutRound("Checking the"), readToolRound("call-1"), textRound("Done.")]);

    expect(seen).toHaveLength(3);
    expect(mockDispatchTool).toHaveBeenCalledTimes(1);
    const rows = savedRows();
    expect(rows.map((r) => r.content)).toEqual([`Checking the${CUTOFF_ANSWER_SUFFIX}`, "", "Done."]);
    expect(requireValue(rows[1]).toolCalls).toHaveLength(1);
    // The fragment is now real history, so the next request sees it.
    expect(seenAt(seen, 2).history.some((m) => m.content === `Checking the${CUTOFF_ANSWER_SUFFIX}`)).toBe(true);
    expect(seenAt(seen, 2).turnState).not.toContain(NOTE_HEADING);
    expect(result.text).toBe("Done.");
  });

  it("switched off: the fragment is saved as-is and no continuation is sent", async () => {
    cutoffSwitch.enabled = false;
    const { result, seen } = await run([cutRound("Half an ans"), textRound("unreachable")]);

    expect(seen).toHaveLength(1);
    expect(onlyRow().content).toBe("Half an ans");
    expect(result.text).toBe("Half an ans");
    expect(result.stopReason).toBe(null);
    expect(infoCalls("engine.turn.cutoff_continuation")).toHaveLength(0);
  });

  describe("tool-call rounds cut off by the output limit are never continued", () => {
    it("a complete tool batch under length is refused whole: nothing dispatched or saved, one recovery", async () => {
      const { result, seen } = await run([readToolRound("call-1", "length"), textRound("Done.")]);

      expect(mockDispatchTool).not.toHaveBeenCalled();
      expect(seen).toHaveLength(2);
      expect(seen.some((s) => s.turnState.includes(NOTE_HEADING))).toBe(false);
      expect(seenAt(seen, 1).turnState).toContain(buildStallRecoveryNote("incomplete_tool_batch"));
      // No tool-call message was persisted: the only row is the final answer.
      expect(savedRows().map((r) => r.content)).toEqual(["Done."]);
      expect(savedRows().some((r) => (r.toolCalls?.length ?? 0) > 0)).toBe(false);
      expect(warnCalls("engine.turn.incomplete_inference")[0]).toMatchObject({
        truncated: true,
        validToolCalls: 1,
        malformedToolCalls: 0,
      });
      expect(result.text).toBe("Done.");
    });

    it("two complete calls cut off exactly between them by length: neither is dispatched", async () => {
      const { seen } = await run([twoReadToolsRound("length"), textRound("Done.")]);

      expect(mockDispatchTool).not.toHaveBeenCalled();
      expect(seen.some((s) => s.turnState.includes(NOTE_HEADING))).toBe(false);
      expect(seenAt(seen, 1).turnState).toContain(buildStallRecoveryNote("incomplete_tool_batch"));
      expect(savedRows().some((r) => (r.toolCalls?.length ?? 0) > 0)).toBe(false);
      expect(warnCalls("engine.turn.incomplete_inference")[0]).toMatchObject({
        truncated: true,
        validToolCalls: 2,
      });
    });

    it.each(["tool_calls", "stop"])("the same two calls finished by %s are dispatched as before", async (finish) => {
      const { result, seen } = await run([twoReadToolsRound(finish), textRound("Done.")]);

      expect(mockDispatchTool).toHaveBeenCalledTimes(2);
      expect(seen).toHaveLength(2);
      expect(seenAt(seen, 1).turnState).not.toContain(buildStallRecoveryNote("incomplete_tool_batch"));
      expect(savedRows().filter((r) => (r.toolCalls?.length ?? 0) === 2)).toHaveLength(1);
      expect(result.text).toBe("Done.");
    });

    it("a truncated tool batch with text stays an incomplete batch: nothing saved, nothing continued", async () => {
      const { seen } = await run([truncatedToolRound, textRound("Done.")]);

      expect(mockDispatchTool).not.toHaveBeenCalled();
      expect(seen.some((s) => s.turnState.includes(NOTE_HEADING))).toBe(false);
      expect(seenAt(seen, 1).turnState).toContain(buildStallRecoveryNote("incomplete_tool_batch"));
      expect(savedRows().map((r) => r.content)).toEqual(["Done."]);
    });
  });

  it("a board staged during the turn rides on the single combined row", async () => {
    const { result } = await run([cutRound("Board: the po"), textRound("ols look fine.")], {
      onRound: (i) => {
        if (i === 0) stagePresentation(SESSION_ID, boardSpec("SOL majors"), 1);
      },
    });

    const row = onlyRow();
    expect(row.content).toBe("Board: the pools look fine.");
    expect(row.board?.title).toBe("SOL majors");
    expect(result.text).toBe("Board: the pools look fine.");
  });

  it("a mission run continues the same way and gets its continue marker after the ONE row", async () => {
    const { seen } = await run(
      [cutRound("Mission update: bal"), textRound("ances unchanged."), textRound("Next.")],
      { missionRunId: "run-1", maxIterations: 3 },
    );

    expect(seen).toHaveLength(3);
    expect(seenAt(seen, 1).turnState).toContain(CUTOFF_CONTINUATION_NOTE);
    expect(seenAt(seen, 2).turnState).not.toContain(NOTE_HEADING);
    expect(savedRows().map((r) => r.content)).toEqual(["Mission update: balances unchanged.", "Next."]);
    // Every round, the continuation included, is a counted mission iteration.
    expect(mockIncrementIterations).toHaveBeenCalledTimes(3);
    const continueMarkers = mockAddEngineMessage.mock.calls.filter(
      (c: unknown[]) => isRecord(c[2]) && c[2]["messageType"] === "continue",
    );
    expect(continueMarkers).toHaveLength(2);
  });

  it("a turn that ends before the continuation still saves the fragment, marked", async () => {
    const { result, seen } = await run([cutRound("Out of rounds mid-sen"), textRound("unreachable")], {
      maxIterations: 1,
    });

    expect(seen).toHaveLength(1);
    expect(onlyRow().content).toBe(`Out of rounds mid-sen${CUTOFF_ANSWER_SUFFIX}`);
    expect(result.text).toBe(`Out of rounds mid-sen${CUTOFF_ANSWER_SUFFIX}`);
    expect(result.stopReason).toBe("iteration_limit");
    expect(infoCalls("engine.turn.cutoff_continuation_resolved")[0]).toMatchObject({
      outcome: "not_issued",
    });
  });

  it("Stop during the continuation saves fragment + streamed text as one chat_stopped row", async () => {
    const controller = new AbortController();
    let calls = 0;
    const provider = fakeInferenceProvider({
      chatCompletionStream: async function* (): AsyncGenerator<StreamChunk> {
        calls += 1;
        if (calls === 1) {
          for (const chunk of cutRound("First half, ")) yield chunk;
          return;
        }
        yield { type: "content", text: "second h" };
        controller.abort();
        yield { type: "content", text: "DROPPED" };
      },
    });
    const result = await runTurnLoop(
      makeContext(), [], null, 0, provider, makeConfig(), [],
      { maxIterations: 50, timeoutMs: 60000, contextLimit: 128000 },
      {}, undefined, controller.signal,
    );

    expect(result.stopReason).toBe("user_stopped");
    expect(onlyRow()).toMatchObject({ content: "First half, second h", messageType: "chat_stopped" });
  });
});
