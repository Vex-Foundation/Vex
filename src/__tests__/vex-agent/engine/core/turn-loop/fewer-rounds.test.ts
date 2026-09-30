/**
 * Kairos Phase 5 (fewer rounds), driven end to end through `runTurnLoop` with
 * a typed streaming provider that records every request it receives.
 *
 * B-1 honest idle: a mission run whose slice already called `LoopDefer`, and
 * whose wake is pending, parks on that wake when it next replies in prose,
 * with no continue cue. A `LoopDefer` that scheduled nothing leaves real work
 * continuing with the cue.
 *
 * B-4 act, don't narrate: a reply that only announces an action earns ONE
 * one-shot turn-state note on the next call (never persisted, never a user
 * message), at most once per turn, never while an approval is pending, and
 * never for a real answer that merely mentions future steps.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type {
  InferenceConfig,
  InferenceProvider,
  ProviderMessage,
  StreamChunk,
} from "@vex-agent/inference/types.js";
import type { Message } from "@vex-agent/db/repos/messages.js";
import type { LoopWakeRequest } from "@vex-agent/db/repos/loop-wake.js";
import type { EngineContext } from "@vex-agent/engine/types.js";
import { fakeInferenceProvider } from "../../../../helpers/inference-provider.js";

// ── Mocks (the turn-loop-defer.test.ts harness, streaming) ──

const mockAddMessage = vi.fn();
const mockAddEngineMessage = vi.fn();
const mockDispatchTool = vi.fn();
const mockUpdateStatus = vi.fn().mockResolvedValue(true);
const mockGetOperatorInstructionsAfter = vi.fn().mockResolvedValue([]);
const mockLoggerInfo = vi.fn();

vi.mock("@utils/logger.js", () => ({
  default: {
    warn: vi.fn(),
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
  getLiveMessages: vi.fn().mockResolvedValue([]),
  getOperatorInstructionsAfter: (...a: unknown[]) => mockGetOperatorInstructionsAfter(...a),
}));

vi.mock("@vex-agent/engine/events/index.js", () => ({
  appendMessage: (...a: unknown[]) => mockAddMessage(...a),
  appendEngineMessage: (...a: unknown[]) => mockAddEngineMessage(...a),
  emitTranscriptAppend: vi.fn(),
  streamDeltaBus: { emit: vi.fn(), subscribe: vi.fn(), size: vi.fn(), clear: vi.fn() },
  toStreamDeltaEvent: vi.fn(),
  toStreamAbortedEvent: vi.fn(),
}));

vi.mock("@vex-agent/db/repos/mission-runs.js", () => ({
  incrementIterations: vi.fn().mockResolvedValue(1),
  updateStatus: (...a: unknown[]) => mockUpdateStatus(...a),
  updateStatusIfNotTerminal: (...a: unknown[]) => mockUpdateStatus(...a),
  setLastCheckpoint: vi.fn(),
}));

vi.mock("@vex-agent/tools/dispatcher.js", () => ({
  dispatchTool: (...a: unknown[]) => mockDispatchTool(...a),
}));

vi.mock("@vex-agent/db/repos/sessions.js", () => ({
  updateTokenCount: vi.fn(),
  setRollingSummary: vi.fn(),
  archivePrefix: vi.fn(),
  forkToolMessageToArchive: vi.fn(),
  getSession: vi.fn().mockResolvedValue({ tokenCount: 0 }),
}));

vi.mock("@vex-agent/engine/compact-jobs/forced-fallback.js", () => ({
  maybeRunForcedCompactFallback: vi.fn().mockResolvedValue({ kind: "noop" }),
}));

const mockHasPendingForSession = vi
  .fn<(sessionId: string) => Promise<boolean>>()
  .mockResolvedValue(false);
vi.mock("@vex-agent/db/repos/approvals.js", () => ({
  enqueue: vi.fn(),
  enqueueWith: vi.fn(),
  rejectWith: vi.fn().mockResolvedValue(null),
  hasPendingForSession: (sessionId: string) => mockHasPendingForSession(sessionId),
}));

vi.mock("@vex-agent/db/repos/approval-intents.js", () => ({
  createWith: vi.fn(),
}));

vi.mock("@vex-agent/db/repos/usage.js", () => ({
  logUsage: vi.fn(),
}));

vi.mock("@vex-agent/db/repos/runtime-timings.js", () => ({
  insertTurnRunTiming: vi.fn().mockResolvedValue(undefined),
  insertInferenceAttempt: vi.fn().mockResolvedValue(undefined),
  insertToolDispatchTiming: vi.fn().mockResolvedValue(undefined),
  recordInBackground: vi.fn(),
}));

const mockGetPendingWake = vi
  .fn<(sessionId: string) => Promise<LoopWakeRequest | null>>()
  .mockResolvedValue(null);
vi.mock("@vex-agent/db/repos/loop-wake.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@vex-agent/db/repos/loop-wake.js")>()),
  getPendingForSession: (sessionId: string) => mockGetPendingWake(sessionId),
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

// The REAL operator-stop gate runs inside the wake park, driven by the SQL
// stubs above; only the lease claims are stubbed.
vi.mock("@vex-agent/engine/runtime/lease-and-status.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@vex-agent/engine/runtime/lease-and-status.js")>()),
  claimRunLeaseAndFlipToRunning: vi.fn(),
  claimSessionLease: vi.fn(),
  observeAndApplyControl: vi.fn().mockResolvedValue({ outcome: "no_request" }),
}));

vi.mock("@vex-agent/engine/runtime/release-and-emit.js", () => ({
  releaseLeaseAndEmitControlState: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@vex-agent/engine/prompts/own-token-banner.js", () => ({
  buildOwnTokenBanner: vi.fn().mockResolvedValue(""),
}));

vi.mock("@vex-agent/tools/protocols/catalog.js", () => ({
  PROTOCOL_TOOLS: [],
  PROTOCOL_NAMESPACE_ALLOWLIST: [],
}));

const { runTurnLoop } = await import("@vex-agent/engine/core/turn-loop.js");
const { MISSION_CONTINUE_CUE } = await import("@vex-agent/engine/core/turn-loop-text-response.js");

// ── Scripted rounds ─────────────────────────────────────────────

function textRound(text: string): readonly StreamChunk[] {
  return [{ type: "content", text }, { type: "done", finishReason: "stop" }];
}

function toolRound(id: string, name: string, args: Record<string, unknown>): readonly StreamChunk[] {
  return [
    {
      type: "tool_call_delta",
      toolCallIndex: 0,
      toolCallId: id,
      toolCallName: name,
      toolCallArgsDelta: JSON.stringify(args),
    },
    { type: "done", finishReason: "tool_calls" },
  ];
}

const loopDeferRound = toolRound("defer-1", "LoopDefer", { after_ms: 600_000, reason: "bridge fill" });

interface SeenRequest {
  readonly turnState: string;
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
    ): AsyncGenerator<StreamChunk> {
      const turnState = messages.filter((m) => m.cacheHint === "turn_state");
      seen.push({
        turnState: turnState.map((m) => m.content).join("\n"),
        history: JSON.stringify(messages.filter((m) => m.cacheHint !== "turn_state")),
      });
      const round = rounds[index] ?? rounds[rounds.length - 1] ?? textRound("Done.");
      index += 1;
      for (const chunk of round) yield chunk;
    },
  });
  return { provider, seen };
}

function makeConfig(): InferenceConfig {
  return {
    provider: "openrouter",
    model: "test-model",
    contextLimit: 128000,
    maxOutputTokens: 4096,
    supportsReasoningEffort: false,
    inputPricePerM: 3,
    outputPricePerM: 15,
    priceCurrency: "USD",
    cachePricePerM: null,
    cacheWritePricePerM: null,
    reasoningPricePerM: null,
  };
}

function missionContext(): EngineContext {
  return {
    sessionId: "session-1",
    sessionKind: "mission",
    sessionPermission: "restricted",
    missionId: "mission-1",
    missionRunId: "run-1",
    selectedEvmWallet: null,
    selectedSolanaWallet: null,
    walletPolicy: { kind: "none" },
    loadedDocuments: new Map<string, string>(),
  };
}

function pendingWake(): LoopWakeRequest {
  return {
    id: "wake-1",
    sessionId: "session-1",
    missionRunId: "run-1",
    dueAt: "2026-09-29T12:00:00.000Z",
    status: "pending",
    reason: "bridge fill",
    payload: null,
    createdAt: "2026-09-29T11:00:00.000Z",
    consumedAt: null,
    cancelledAt: null,
    cancelledReason: null,
  };
}

async function run(
  context: EngineContext,
  rounds: ReadonlyArray<readonly StreamChunk[]>,
  options: { history?: Message[]; maxIterations?: number } = {},
) {
  const { provider, seen } = recordingProvider(rounds);
  const result = await runTurnLoop(
    context, options.history ?? [], null, 0, provider, makeConfig(), [],
    { maxIterations: options.maxIterations ?? 6, timeoutMs: 60_000, contextLimit: 128_000 },
  );
  return { result, seen };
}

function persistedCueCount(): number {
  return mockAddEngineMessage.mock.calls.filter((c) => c[1] === MISSION_CONTINUE_CUE).length;
}

function runStatusWrites(status: string): number {
  return mockUpdateStatus.mock.calls.filter((c) => c[0] === "run-1" && c[1] === status).length;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockUpdateStatus.mockResolvedValue(true);
  mockGetOperatorInstructionsAfter.mockResolvedValue([]);
  mockHasPendingForSession.mockResolvedValue(false);
  mockGetPendingWake.mockResolvedValue(null);
});

describe("B-1 mission honest idle", () => {
  it("a successful LoopDefer ends the slice on the tool signal and writes no continue cue", async () => {
    mockDispatchTool.mockResolvedValueOnce({
      success: true,
      output: "Loop deferred until 2026-09-29T12:00:00.000Z (defer_id=wake-1).",
      engineSignal: {
        type: "defer_until",
        reason: "bridge fill",
        summary: "Deferred until 2026-09-29T12:00:00.000Z",
        dueAt: "2026-09-29T12:00:00.000Z",
      },
    });

    const { result, seen } = await run(missionContext(), [loopDeferRound, textRound("never reached")]);

    expect(result.stopReason).toBe("waiting_for_wake");
    expect(seen).toHaveLength(1);
    expect(persistedCueCount()).toBe(0);
    expect(runStatusWrites("paused_wake")).toBe(1);
  });

  it("LoopDefer refused because this run's wake is already pending: the prose reply parks the run, no cue", async () => {
    mockDispatchTool.mockResolvedValueOnce({
      success: false,
      output: "LoopDefer: a pending wake already exists for this session.",
    });
    mockGetPendingWake.mockResolvedValue(pendingWake());

    const { result, seen } = await run(missionContext(), [
      loopDeferRound,
      textRound("A wake is already scheduled for the bridge fill; nothing else to do now."),
      textRound("never reached"),
    ]);

    expect(seen).toHaveLength(2);
    expect(result.stopReason).toBe("waiting_for_wake");
    expect(result.stopPayload?.evidence).toEqual({
      dueAt: "2026-09-29T12:00:00.000Z",
      reason: "bridge fill",
    });
    expect(persistedCueCount()).toBe(0);
    expect(runStatusWrites("paused_wake")).toBe(1);
    expect(mockLoggerInfo.mock.calls.some((c) => c[0] === "engine.mission.idle_defer_parked")).toBe(true);
  });

  it("LoopDefer that scheduled nothing (condition already true): real work continues with the cue", async () => {
    mockDispatchTool
      .mockResolvedValueOnce({
        success: true,
        output: "Not deferred - ETH is already above 3000. Act on it now.",
        data: { deferred: false },
      })
      .mockResolvedValue({ success: true, output: "{\"balance\":\"1.0\"}", actionKind: "read" });
    mockGetPendingWake.mockResolvedValue(null);

    const { result, seen } = await run(
      missionContext(),
      [
        loopDeferRound,
        textRound("The price is already there, so I will act on it."),
        toolRound("read-1", "WalletBalances", {}),
        textRound("Balance read."),
      ],
      { maxIterations: 4 },
    );

    expect(seen).toHaveLength(4);
    expect(result.stopReason).toBe("iteration_limit");
    expect(persistedCueCount()).toBe(2);
    expect(runStatusWrites("paused_wake")).toBe(0);
  });

  it("mission prose with no LoopDefer in the slice keeps the continue cue and reads no wake", async () => {
    const { result, seen } = await run(
      missionContext(),
      [textRound("Assessing the market."), textRound("Still assessing.")],
      { maxIterations: 2 },
    );

    expect(seen).toHaveLength(2);
    expect(result.stopReason).toBe("iteration_limit");
    expect(persistedCueCount()).toBe(1);
    expect(mockGetPendingWake).not.toHaveBeenCalled();
  });
});

const NOTE_HEADING = "# Last Reply Announced An Action";

function agentContext(overrides: Partial<EngineContext> = {}): EngineContext {
  return { ...missionContext(), sessionKind: "agent", missionId: null, missionRunId: null, ...overrides };
}

const askHistory: Message[] = [{ role: "user", content: "What is ETH at?", timestamp: "2026-09-29T11:00:00.000Z" }];

function persistedText(): string {
  return JSON.stringify([...mockAddMessage.mock.calls, ...mockAddEngineMessage.mock.calls]);
}

function nudgeLogs(): unknown[] {
  return mockLoggerInfo.mock.calls.filter((c) => c[0] === "engine.turn.promise_nudge").map((c) => c[1]);
}

describe("B-4 promise-only nudge", () => {
  beforeEach(() => {
    mockDispatchTool.mockResolvedValue({ success: true, output: "{\"ok\":true}", actionKind: "read" });
  });

  it("chat: a promise-only reply gets one note on the next call, which then acts", async () => {
    const { result, seen } = await run(
      agentContext(),
      [
        textRound("Let me check the current ETH price."),
        toolRound("read-1", "ToolSearch", { query: "eth price" }),
        textRound("ETH is at $3,012."),
      ],
      { history: askHistory },
    );

    expect(seen).toHaveLength(3);
    expect(seen[0]?.turnState).not.toContain(NOTE_HEADING);
    expect(seen[1]?.turnState).toContain(NOTE_HEADING);
    expect(seen[2]?.turnState).not.toContain(NOTE_HEADING);
    // Turn state only: never in the history, never persisted, never a user row.
    expect(seen[1]?.history).not.toContain(NOTE_HEADING);
    expect(persistedText()).not.toContain(NOTE_HEADING);
    expect(result.stopReason).toBe(null);
    expect(result.text).toBe("ETH is at $3,012.");
    expect(nudgeLogs()).toEqual([
      { sessionId: "session-1", missionRunId: null, sessionKind: "agent", iteration: 0, replyChars: 35 },
    ]);
  });

  it("at most one nudge per turn: a second promise-only reply is accepted as the answer", async () => {
    const { result, seen } = await run(
      agentContext(),
      [textRound("Let me check the current ETH price."), textRound("I'll fetch it now.")],
      { history: askHistory },
    );

    expect(seen).toHaveLength(2);
    expect(result.stopReason).toBe(null);
    expect(result.text).toBe("I'll fetch it now.");
    expect(nudgeLogs()).toHaveLength(1);
  });

  it("false-positive guard: a legitimate final answer that mentions future steps ends the turn", async () => {
    const answer =
      "ETH is trading at $3,012, up 2.1% today. Next steps: once your bridge settles, I'll check the balance and then place the swap.";
    const { result, seen } = await run(agentContext(), [textRound(answer), textRound("never reached")], {
      history: askHistory,
    });

    expect(seen).toHaveLength(1);
    expect(result.text).toBe(answer);
    expect(nudgeLogs()).toHaveLength(0);
  });

  it("waiting for approval is a valid end state: no nudge while an approval is pending", async () => {
    mockHasPendingForSession.mockResolvedValue(true);
    const { seen } = await run(
      agentContext(),
      [textRound("Let me check the current ETH price."), textRound("never reached")],
      { history: askHistory },
    );

    expect(seen).toHaveLength(1);
    expect(nudgeLogs()).toHaveLength(0);
  });

  it("mission setup is never nudged", async () => {
    const { seen } = await run(
      agentContext({ sessionKind: "mission", missionId: "mission-1" }),
      [textRound("Let me check the current ETH price."), textRound("never reached")],
      { history: askHistory },
    );

    expect(seen).toHaveLength(1);
    expect(nudgeLogs()).toHaveLength(0);
  });

  it("mission run: the note rides with the continue round it already had, once", async () => {
    const { seen } = await run(
      missionContext(),
      [
        textRound("Let me check the current ETH price."),
        textRound("I'll fetch it now."),
        textRound("Still here."),
      ],
      { maxIterations: 3 },
    );

    expect(seen).toHaveLength(3);
    expect(seen[1]?.turnState).toContain(NOTE_HEADING);
    expect(seen[2]?.turnState).not.toContain(NOTE_HEADING);
    expect(persistedCueCount()).toBe(1);
    expect(nudgeLogs()).toHaveLength(1);
  });
});
