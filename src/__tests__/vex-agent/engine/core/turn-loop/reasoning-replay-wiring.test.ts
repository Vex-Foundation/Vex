/**
 * Reasoning replay (Kairos R-7) wired through `runTurnLoop`, with a typed
 * streaming provider that records every request it receives.
 *
 * The switch is replaced through `vi.mock` with a getter, so one file covers
 * both positions: OFF sends every request exactly as before (no message ever
 * carries a replay), ON hands a round's reasoning back on its own assistant
 * tool-call message for the rest of THAT run only, keeps it stable across
 * later rounds, and drops it across a serving-provider switch or for a family
 * outside the allow-list.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type {
  InferenceConfig,
  InferenceProvider,
  ProviderMessage,
  ReasoningReplayPayload,
  StreamChunk,
} from "@vex-agent/inference/types.js";
import type { Message } from "@vex-agent/db/repos/messages.js";
import type { LoopWakeRequest } from "@vex-agent/db/repos/loop-wake.js";
import type { EngineContext } from "@vex-agent/engine/types.js";
import { fakeInferenceProvider } from "../../../../helpers/inference-provider.js";
import { requireValue } from "../../../../helpers/require-value.js";

const replaySwitch = vi.hoisted(() => ({ on: false }));
vi.mock("@vex-agent/inference/openrouter/reasoning-replay.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@vex-agent/inference/openrouter/reasoning-replay.js")>();
  return {
    ...actual,
    get REASONING_REPLAY_ENABLED() {
      return replaySwitch.on;
    },
  };
});

// Mocks: the fewer-rounds.test.ts harness, streaming.

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
const { replayFromCompleteDetails } = await import("@vex-agent/inference/openrouter/reasoning-replay.js");

const REPLAY: ReasoningReplayPayload = requireValue(replayFromCompleteDetails([
  { type: "reasoning.text", text: "Read the balance first.", signature: "sig-1", format: "anthropic-claude-v1", index: 0 },
]));
const REPLAY_2: ReasoningReplayPayload = requireValue(replayFromCompleteDetails([
  { type: "reasoning.text", text: "Now the price.", signature: "sig-2", format: "anthropic-claude-v1", index: 0 },
]));

function toolRound(
  id: string,
  replay: ReasoningReplayPayload | null,
  servingProvider = "Anthropic",
): readonly StreamChunk[] {
  return [
    {
      type: "tool_call_delta",
      toolCallIndex: 0,
      toolCallId: id,
      toolCallName: "wallet_balance",
      toolCallArgsDelta: "{}",
    },
    {
      type: "done",
      finishReason: "tool_calls",
      servingProvider,
      ...(replay !== null && { reasoningReplay: replay }),
    },
  ];
}

function textRound(text: string, servingProvider = "Anthropic"): readonly StreamChunk[] {
  return [{ type: "content", text }, { type: "done", finishReason: "stop", servingProvider }];
}

function recordingProvider(rounds: ReadonlyArray<readonly StreamChunk[]>): {
  readonly provider: InferenceProvider;
  readonly seen: ProviderMessage[][];
} {
  const seen: ProviderMessage[][] = [];
  let index = 0;
  const provider = fakeInferenceProvider({
    chatCompletionStream: async function* (messages: ProviderMessage[]): AsyncGenerator<StreamChunk> {
      seen.push(messages);
      const round = rounds[index] ?? textRound("Done.");
      index += 1;
      for (const chunk of round) yield chunk;
    },
  });
  return { provider, seen };
}

function makeConfig(model: string): InferenceConfig {
  return {
    provider: "openrouter",
    model,
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

function agentContext(): EngineContext {
  return {
    sessionId: "session-1",
    sessionKind: "agent",
    sessionPermission: "restricted",
    missionId: null,
    missionRunId: null,
    selectedEvmWallet: null,
    selectedSolanaWallet: null,
    walletPolicy: { kind: "none" },
    loadedDocuments: new Map<string, string>(),
  };
}

async function run(
  rounds: ReadonlyArray<readonly StreamChunk[]>,
  model = "anthropic/claude-sonnet-4.5",
  history: Message[] = [],
) {
  const { provider, seen } = recordingProvider(rounds);
  const result = await runTurnLoop(
    agentContext(), history, null, 0, provider, makeConfig(model), [],
    { maxIterations: 6, timeoutMs: 60_000, contextLimit: 128_000 },
  );
  return { result, seen };
}

/** The replay carried by the assistant row whose single call has `id`. */
function replayOn(request: readonly ProviderMessage[] | undefined, id: string): ReasoningReplayPayload | undefined {
  const message = requireValue(request).find(
    (m) => m.role === "assistant" && m.toolCalls?.length === 1 && m.toolCalls[0]?.id === id,
  );
  return requireValue(message).reasoningReplay;
}

function carriers(request: readonly ProviderMessage[] | undefined): number {
  return requireValue(request).filter((m) => m.reasoningReplay !== undefined).length;
}

beforeEach(() => {
  vi.clearAllMocks();
  replaySwitch.on = false;
  mockUpdateStatus.mockResolvedValue(true);
  mockGetOperatorInstructionsAfter.mockResolvedValue([]);
  mockHasPendingForSession.mockResolvedValue(false);
  mockGetPendingWake.mockResolvedValue(null);
  mockDispatchTool.mockResolvedValue({ success: true, output: "{\"usd\":12}" });
});

describe("R-7 OFF: no request carries a replay", () => {
  it("even when the provider returned one", async () => {
    const { result, seen } = await run([toolRound("call-1", REPLAY), textRound("12 USD.")]);
    expect(result.text).toBe("12 USD.");
    expect(seen).toHaveLength(2);
    expect(seen.map(carriers)).toEqual([0, 0]);
  });
});

describe("R-7 ON: replay within the run", () => {
  it("hands each round's reasoning back on its own tool-call message, stable on later rounds", async () => {
    replaySwitch.on = true;
    const { seen } = await run([
      toolRound("call-1", REPLAY),
      toolRound("call-2", REPLAY_2),
      textRound("Done."),
    ]);
    expect(seen).toHaveLength(3);
    expect(carriers(seen[0])).toBe(0);
    expect(replayOn(seen[1], "call-1")).toBe(REPLAY);
    // Round 3: the round-1 message is unchanged (same payload, same place), so
    // the cached prefix up to it is the one round 2 sent.
    expect(replayOn(seen[2], "call-1")).toBe(REPLAY);
    expect(replayOn(seen[2], "call-2")).toBe(REPLAY_2);
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      "engine.turn.reasoning_replay",
      expect.objectContaining({ attachedMessages: 2 }),
    );
  });

  it("never leaks the payload into a log line", async () => {
    replaySwitch.on = true;
    await run([toolRound("call-1", REPLAY), textRound("Done.")]);
    const logged = JSON.stringify(mockLoggerInfo.mock.calls);
    expect(logged).not.toContain("sig-1");
    expect(logged).not.toContain("Read the balance first.");
  });

  it("drops replays once the serving provider changes", async () => {
    replaySwitch.on = true;
    const { seen } = await run([
      toolRound("call-1", REPLAY, "Anthropic"),
      toolRound("call-2", null, "Amazon Bedrock"),
      textRound("Done.", "Amazon Bedrock"),
    ]);
    expect(replayOn(seen[1], "call-1")).toBe(REPLAY);
    expect(replayOn(seen[2], "call-1")).toBeUndefined();
  });

  it("never attaches for a family outside the allow-list", async () => {
    replaySwitch.on = true;
    const { seen } = await run([toolRound("call-1", REPLAY), textRound("Done.")], "qwen/qwen3-max");
    expect(seen.map(carriers)).toEqual([0, 0]);
  });

  it("a new run starts empty: the previous run's reasoning is not carried over", async () => {
    replaySwitch.on = true;
    const first = await run([toolRound("call-1", REPLAY), textRound("Done.")]);
    expect(replayOn(first.seen[1], "call-1")).toBe(REPLAY);
    const tape: Message[] = requireValue(first.seen[1])
      .filter((m) => m.cacheHint !== "static_prefix" && m.cacheHint !== "turn_state")
      .map((m) => ({
        role: m.role,
        content: m.content,
        timestamp: "2026-09-30T00:00:00.000Z",
        ...(m.toolCallId !== undefined && { toolCallId: m.toolCallId }),
        ...(m.toolCalls !== undefined && { toolCalls: m.toolCalls }),
      }));
    const second = await run([textRound("Still 12 USD.")], "anthropic/claude-sonnet-4.5", tape);
    expect(second.seen.map(carriers)).toEqual([0]);
  });
});
