/**
 * T-5 (Kairos Phase 6): provider rounds for a "price of ETH" chat, measured
 * end to end through `runTurnLoop` with the REAL tools array, the REAL
 * dispatcher, the REAL `ToolSearch` lane and the REAL admission check. Only the
 * provider (scripted), the DexScreener handler (`executeProtocolTool`, so no
 * network) and the persistence layer are doubles.
 *
 * The scripted model reads the tools array it is actually sent each round and
 * behaves as the live transcript did (2026-09-30, deepseek-v4.1-flash): with no
 * DexScreener schema in front of it, it reaches the namespace through
 * `ToolSearch` (a listing, then a select, which is the two-round path; or one
 * ranked search); once `dexscreener__pairs_search` is in its tools it calls it;
 * once it has the rows it answers. Rounds are counted as provider requests.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  InferenceConfig,
  ProviderMessage,
  StreamChunk,
  ToolDefinition,
} from "@vex-agent/inference/types.js";
import type { EngineContext } from "@vex-agent/engine/types.js";
import type { ToolResult } from "@vex-agent/tools/types.js";
import { fakeInferenceProvider } from "../../../../helpers/inference-provider.js";

// ── Switch under test, flipped per case ─────────────────────────

const policy = { corePreloaded: false };
vi.mock("@vex-agent/tools/registry/discovery-policy.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@vex-agent/tools/registry/discovery-policy.js")>();
  return {
    ...actual,
    get CORE_MARKET_READS_PRELOADED(): boolean {
      return policy.corePreloaded;
    },
  };
});

// ── Doubles: DexScreener handler, embeddings, persistence ───────

const mockExecuteProtocolTool = vi.fn<(...args: unknown[]) => Promise<ToolResult>>();
vi.mock("@vex-agent/tools/protocols/runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@vex-agent/tools/protocols/runtime.js")>();
  return { ...actual, executeProtocolTool: (...args: unknown[]) => mockExecuteProtocolTool(...args) };
});

vi.mock("@vex-agent/embeddings/client.js", () => ({
  embedDocument: vi.fn().mockRejectedValue(new Error("no embeddings in this test")),
  embedQuery: vi.fn().mockRejectedValue(new Error("no embeddings in this test")),
  formatDocumentInput: (t: string, s: string) => `${t} ${s}`,
  formatQueryInput: (q: string) => q,
}));

vi.mock("@utils/logger.js", () => ({
  default: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock("@vex-agent/engine/compaction/apply/index.js", () => ({
  createCompactionApplyAction: () => ({
    name: "compaction_apply",
    phase: "apply" as const,
    run: async () => ({ kind: "continue" as const }),
  }),
}));

vi.mock("@vex-agent/db/repos/messages.js", () => ({
  addMessage: vi.fn(),
  addEngineMessage: vi.fn(),
  addMessageReturningId: vi.fn().mockResolvedValue({
    id: 1,
    role: "assistant",
    content: "",
    timestamp: new Date().toISOString(),
  }),
  getLiveMessages: vi.fn().mockResolvedValue([]),
  getOperatorInstructionsAfter: vi.fn().mockResolvedValue([]),
}));

vi.mock("@vex-agent/engine/events/index.js", () => ({
  appendMessage: vi.fn(),
  appendEngineMessage: vi.fn(),
  emitTranscriptAppend: vi.fn(),
  streamDeltaBus: { emit: vi.fn(), subscribe: vi.fn(), size: vi.fn(), clear: vi.fn() },
  toStreamDeltaEvent: vi.fn(),
  toStreamAbortedEvent: vi.fn(),
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

vi.mock("@vex-agent/db/repos/approvals.js", () => ({
  enqueue: vi.fn(),
  enqueueWith: vi.fn(),
  rejectWith: vi.fn().mockResolvedValue(null),
  hasPendingForSession: vi.fn().mockResolvedValue(false),
}));

vi.mock("@vex-agent/db/repos/approval-intents.js", () => ({ createWith: vi.fn() }));
vi.mock("@vex-agent/db/repos/usage.js", () => ({ logUsage: vi.fn() }));

vi.mock("@vex-agent/db/repos/runtime-timings.js", () => ({
  insertTurnRunTiming: vi.fn().mockResolvedValue(undefined),
  insertInferenceAttempt: vi.fn().mockResolvedValue(undefined),
  insertToolDispatchTiming: vi.fn().mockResolvedValue(undefined),
  recordInBackground: vi.fn(),
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
    return null;
  }),
  executeWith: vi.fn().mockResolvedValue(1),
  withTransaction: vi.fn().mockImplementation(async (fn: (client: unknown) => Promise<unknown>) => {
    const stubClient = { query: vi.fn().mockResolvedValue({ rows: [] }), release: vi.fn() };
    return await fn(stubClient);
  }),
}));

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

const { runTurnLoop } = await import("@vex-agent/engine/core/turn-loop.js");
const { clearDiscoveredTools } = await import("@vex-agent/tools/registry/discovered-tools.js");

// ── The scripted model ──────────────────────────────────────────

const PRICE_READ = "dexscreener__pairs_search";

type DiscoveryHabit = "listing-then-select" | "ranked-search";

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

function textRound(text: string): readonly StreamChunk[] {
  return [{ type: "content", text }, { type: "done", finishReason: "stop" }];
}

interface Round {
  readonly called: string;
  readonly toolsSent: number;
  readonly toolsBytes: number;
}

/**
 * Decides each round from what it was SENT: its own prior calls (the history)
 * and the tools array of this request.
 */
function scriptedModel(habit: DiscoveryHabit): {
  readonly provider: ReturnType<typeof fakeInferenceProvider>;
  readonly rounds: Round[];
} {
  const rounds: Round[] = [];
  const provider = fakeInferenceProvider({
    chatCompletionStream: async function* (
      messages: ProviderMessage[],
      tools: ToolDefinition[],
    ): AsyncGenerator<StreamChunk> {
      const toolResults = messages.filter((m) => m.role === "tool").map((m) => m.content).join("\n");
      const names = new Set(tools.map((tool) => tool.function.name));
      const index = rounds.length;
      let round: readonly StreamChunk[];
      let called: string;
      if (toolResults.includes("\"pair\":\"WETH/USDC\"")) {
        called = "answer";
        round = textRound("ETH is trading at $2,500.00 on the deepest WETH/USDC pool.");
      } else if (names.has(PRICE_READ)) {
        called = PRICE_READ;
        round = toolRound(`c${String(index)}`, PRICE_READ, { query: "WETH", chain: "ethereum" });
      } else if (habit === "ranked-search") {
        called = "ToolSearch(query)";
        round = toolRound(`c${String(index)}`, "ToolSearch", {
          query: "search pairs by token symbol",
          namespace: "dexscreener",
          limit: 1,
        });
      } else if (!toolResults.includes("\"method\":\"list\"")) {
        called = "ToolSearch(namespace)";
        round = toolRound(`c${String(index)}`, "ToolSearch", { namespace: "dexscreener" });
      } else {
        called = "ToolSearch(select)";
        round = toolRound(`c${String(index)}`, "ToolSearch", { query: `select:${PRICE_READ}` });
      }
      rounds.push({ called, toolsSent: tools.length, toolsBytes: JSON.stringify(tools).length });
      for (const chunk of round) yield chunk;
    },
  });
  return { provider, rounds };
}

function config(): InferenceConfig {
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

const SESSION = "t5-rounds-session";

function agentContext(): EngineContext {
  return {
    sessionId: SESSION,
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

async function priceQuestion(habit: DiscoveryHabit, corePreloaded: boolean): Promise<Round[]> {
  policy.corePreloaded = corePreloaded;
  clearDiscoveredTools(SESSION);
  const { provider, rounds } = scriptedModel(habit);
  await runTurnLoop(
    agentContext(), [], null, 0, provider, config(), [],
    { maxIterations: 8, timeoutMs: 60_000, contextLimit: 128_000 },
  );
  return rounds;
}

beforeEach(() => {
  mockExecuteProtocolTool.mockReset();
  mockExecuteProtocolTool.mockResolvedValue({
    success: true,
    output: JSON.stringify({ rows: [{ pair: "WETH/USDC", priceUsd: "2500.00", chain: "ethereum" }] }),
  });
});

describe("T-5: rounds before the first DexScreener read", () => {
  it("OFF, listing habit (the live transcript): ToolSearch x2, then the read, then the answer", async () => {
    const rounds = await priceQuestion("listing-then-select", false);
    expect(rounds.map((round) => round.called)).toEqual([
      "ToolSearch(namespace)",
      "ToolSearch(select)",
      PRICE_READ,
      "answer",
    ]);
    expect(mockExecuteProtocolTool).toHaveBeenCalledTimes(1);
  });

  it("OFF, ranked-search habit: ToolSearch x1, then the read, then the answer", async () => {
    const rounds = await priceQuestion("ranked-search", false);
    expect(rounds.map((round) => round.called)).toEqual(["ToolSearch(query)", PRICE_READ, "answer"]);
  });

  it("ON: the read happens on round 1 under either habit, 2 rounds in total", async () => {
    for (const habit of ["listing-then-select", "ranked-search"] as const) {
      mockExecuteProtocolTool.mockClear();
      const rounds = await priceQuestion(habit, true);
      expect(rounds.map((round) => round.called)).toEqual([PRICE_READ, "answer"]);
      expect(mockExecuteProtocolTool).toHaveBeenCalledTimes(1);
    }
  });

  it("reports the tools-array bytes each path sends (the cost side of the switch)", async () => {
    const off = await priceQuestion("listing-then-select", false);
    const on = await priceQuestion("listing-then-select", true);
    const total = (rounds: readonly Round[]) => rounds.reduce((sum, round) => sum + round.toolsBytes, 0);
    // Measured, printed for the tracker: per-round bytes and the turn total.
    process.stdout.write(`${JSON.stringify({
      t5ToolsBytesPerRound: { off: off.map((round) => round.toolsBytes), on: on.map((round) => round.toolsBytes) },
      t5ToolsBytesTurnTotal: { off: total(off), on: total(on) },
    })}\n`);
    // ON sends the preload on round 1, so round 1 is larger; the turn is
    // shorter by two rounds, which is where the time goes (first chunk ~5-6 s
    // per round live).
    expect(on).toHaveLength(off.length - 2);
    expect(on[0]?.toolsBytes ?? 0).toBeGreaterThan(off[0]?.toolsBytes ?? 0);
  });
});
