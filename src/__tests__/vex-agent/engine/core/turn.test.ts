import { describe, it, expect, vi, beforeEach } from "vitest";
import type { StreamDeltaEvent } from "../../../../vex-agent/engine/events/index.js";
import type {
  InferenceConfig,
  InferenceProvider,
  StreamChunk,
} from "../../../../vex-agent/inference/types.js";
import type { InferenceAttemptRecord } from "../../../../vex-agent/db/repos/runtime-timings.js";
import type { EngineContext } from "../../../../vex-agent/engine/types/engine-context.js";
import {
  fakeInferenceProvider,
  withoutStreamMethod,
} from "../../../helpers/inference-provider.js";
import { requireValue } from "../../../helpers/require-value.js";

// ── Mocks ─────────────────────────────────────────────────────

const mockAddMessage = vi.fn();
const mockLogUsage = vi.fn();
const mockUpdateTokenCount = vi.fn();

vi.mock("@vex-agent/db/repos/messages.js", () => ({
  addMessage: (...a: unknown[]) => mockAddMessage(...a),
  addEngineMessage: vi.fn(),
  getLiveMessages: vi.fn().mockResolvedValue([]),
}));

vi.mock("@vex-agent/db/repos/usage.js", () => ({
  logUsage: (...a: unknown[]) => mockLogUsage(...a),
}));

vi.mock("@vex-agent/db/repos/sessions.js", () => ({
  updateTokenCount: (...a: unknown[]) => mockUpdateTokenCount(...a),
  getSession: vi.fn(),
}));

// Runtime-timing writes are captured, not executed: each test inspects the
// row `executeTurn` handed to the repo. `recordInBackground` runs the thunk
// synchronously so the row is observable without awaiting anything.
const mockInsertInferenceAttempt = vi
  .fn<(record: InferenceAttemptRecord) => Promise<void>>()
  .mockResolvedValue(undefined);
const mockRecordInBackground = vi.fn((_label: string, write: () => Promise<void>) => {
  void write();
});
vi.mock("@vex-agent/db/repos/runtime-timings.js", () => ({
  insertInferenceAttempt: (record: InferenceAttemptRecord) => mockInsertInferenceAttempt(record),
  insertTurnRunTiming: vi.fn(),
  insertToolDispatchTiming: vi.fn(),
  recordInBackground: (label: string, write: () => Promise<void>) =>
    mockRecordInBackground(label, write),
}));

vi.mock("@vex-agent/db/client.js", () => ({
  execute: vi.fn(),
  query: vi.fn().mockResolvedValue([]),
  queryOne: vi.fn().mockResolvedValue(null),
}));

// Mock the protocols prompt to avoid loading all manifests
vi.mock("@vex-agent/tools/protocols/catalog.js", () => ({
  PROTOCOL_TOOLS: [],
  PROTOCOL_NAMESPACE_ALLOWLIST: [],
}));

const { executeTurn } = await import("../../../../vex-agent/engine/core/turn.js");
const { commitEndpointSwitch, resetAllSessionEndpointState } = await import(
  "../../../../vex-agent/inference/openrouter/endpoint-failover/session-endpoint-state.js"
);
const { streamDeltaBus } = await import("../../../../vex-agent/engine/events/index.js");

describe("turn", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

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

  const COST_RESULT = {
    totalCost: 0.001,
    currency: "USD",
    breakdown: { promptCost: 0.0008, completionCost: 0.0002, cachedSavings: 0, reasoningCost: 0 },
  };

  function makeProvider(response: {
    content?: string | null;
    toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }> | null;
    reasoning?: string | null;
  }) {
    return {
      chatCompletion: vi.fn().mockResolvedValue({
        content: response.content ?? null,
        toolCalls: response.toolCalls ?? null,
        reasoning: response.reasoning ?? null,
        usage: { promptTokens: 1000, completionTokens: 200, cachedTokens: 0, reasoningTokens: 0 },
      }),
      // chatCompletionSimple stays on the contract (used by checkpoint extract/merge)
      // but the recall path no longer calls it — see "recall path" tests below.
      chatCompletionSimple: vi.fn(),
      calculateCost: vi.fn().mockReturnValue(COST_RESULT),
    };
  }

  // The 9-1 streaming producer: a provider whose chatCompletionStream yields
  // chunks. `chatCompletion` must NOT be called on this path (no fallback).
  // The chatCompletion-only `makeProvider` mocks above now exercise the
  // fallback path inside `runStreamingInference`.
  function makeStreamingProvider(chunks: StreamChunk[]) {
    return {
      id: "fake",
      chatCompletionStream: async function* (): AsyncGenerator<StreamChunk> {
        for (const chunk of chunks) yield chunk;
      },
      chatCompletion: vi.fn(),
      chatCompletionSimple: vi.fn(),
      calculateCost: vi.fn().mockReturnValue(COST_RESULT),
    };
  }

  function makeConfig() {
    return {
      provider: "openrouter",
      model: "anthropic/claude-sonnet-4",
      contextLimit: 128000,
      maxOutputTokens: 4096,
      inputPricePerM: 3,
      outputPricePerM: 15,
    };
  }

  it("returns text response", async () => {
    const provider = makeProvider({ content: "Your balance is 2.5 SOL" });
    const result = await executeTurn(
      makeContext(), [], null, provider as any, makeConfig() as any, [],
    );

    expect(result.content).toBe("Your balance is 2.5 SOL");
    expect(result.toolCalls).toBeNull();
    expect(result.promptTokens).toBe(1000);
    expect(result.reasoning).toBeNull();
  });

  it("surfaces the provider reasoning trace on the buffered fallback path", async () => {
    const provider = makeProvider({ content: "answer", reasoning: "I checked the balance" });
    const result = await executeTurn(
      makeContext(), [], null, provider as any, makeConfig() as any, [],
    );

    expect(result.reasoning).toBe("I checked the balance");
  });

  it("returns tool calls", async () => {
    const provider = makeProvider({
      toolCalls: [{ id: "call-1", name: "discover_tools", arguments: { query: "balance" } }],
    });
    const result = await executeTurn(
      makeContext(), [], null, provider as any, makeConfig() as any, [],
    );

    expect(result.content).toBeNull();
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls![0].name).toBe("discover_tools");
  });

  it("does NOT save assistant message to DB (deferred to turn-loop)", async () => {
    const provider = makeProvider({ content: "Hello" });
    await executeTurn(makeContext(), [], null, provider as any, makeConfig() as any, []);

    // executeTurn no longer saves — turn-loop handles deferred save after
    // determining the canonical batch prefix (trimming unexecuted tool calls).
    expect(mockAddMessage).not.toHaveBeenCalled();
  });

  it("logs usage after inference", async () => {
    const provider = makeProvider({ content: "Hi" });
    await executeTurn(makeContext(), [], null, provider as any, makeConfig() as any, []);

    expect(mockLogUsage).toHaveBeenCalledWith("session-1", expect.objectContaining({
      promptTokens: 1000,
      completionTokens: 200,
    }));
  });

  it("logs cachedSavings from the cost breakdown + cacheWriteTokens from usage (D-SAVINGS)", async () => {
    const provider = {
      id: "fake",
      chatCompletionStream: async function* (): AsyncGenerator<StreamChunk> {
        yield {
          type: "usage",
          usage: {
            promptTokens: 1000, completionTokens: 200, totalTokens: 1200,
            cachedTokens: 600, cacheWriteTokens: 35,
          },
        };
        yield { type: "content", text: "ok" };
        yield { type: "done" };
      },
      chatCompletion: vi.fn(),
      chatCompletionSimple: vi.fn(),
      calculateCost: vi.fn().mockReturnValue({
        totalCost: 0.001,
        currency: "USD",
        // NEGATIVE net savings — persisted truthfully, never clamped.
        breakdown: { promptCost: 0.0008, completionCost: 0.0002, cachedSavings: -0.00004, reasoningCost: 0 },
      }),
    };
    await executeTurn(makeContext(), [], null, provider as any, makeConfig() as any, []);

    expect(mockLogUsage).toHaveBeenCalledWith("session-1", expect.objectContaining({
      cachedSavings: -0.00004,
      cacheWriteTokens: 35,
    }));
  });

  it("defaults cacheWriteTokens to 0 when the provider omits it", async () => {
    const provider = makeProvider({ content: "Hi" });
    await executeTurn(makeContext(), [], null, provider as any, makeConfig() as any, []);

    expect(mockLogUsage).toHaveBeenCalledWith("session-1", expect.objectContaining({
      cachedSavings: 0,
      cacheWriteTokens: 0,
    }));
  });

  it("updates token count after inference", async () => {
    const provider = makeProvider({ content: "Hi" });
    await executeTurn(makeContext(), [], null, provider as any, makeConfig() as any, []);

    expect(mockUpdateTokenCount).toHaveBeenCalledWith("session-1", 1000);
  });

  it("includes summary in provider messages when available", async () => {
    const provider = makeProvider({ content: "Continuing..." });
    await executeTurn(
      makeContext(), [], "Previous session summary", provider as any, makeConfig() as any, [],
    );

    const [providerMessages] = provider.chatCompletion.mock.calls[0];
    const summaryMsg = providerMessages.find((m: any) => m.content.includes("Previous session summary"));
    expect(summaryMsg).toBeTruthy();
  });

  it("passes existing messages to provider", async () => {
    const provider = makeProvider({ content: "OK" });
    const messages = [
      { role: "user" as const, content: "Check balance", timestamp: "2026-03-29T10:00:00Z" },
    ];
    await executeTurn(
      makeContext(), messages, null, provider as any, makeConfig() as any, [],
    );

    const [providerMessages] = provider.chatCompletion.mock.calls[0];
    const userMsg = providerMessages.find((m: any) => m.content === "Check balance");
    expect(userMsg).toBeTruthy();
    expect(userMsg.role).toBe("user");
  });

  it("consumes the provider stream and mirrors ephemeral deltas on streamDeltaBus", async () => {
    const events: StreamDeltaEvent[] = [];
    const off = streamDeltaBus.subscribe((e) => events.push(e));
    try {
      const provider = makeStreamingProvider([
        { type: "content", text: "Bal " },
        { type: "content", text: "2.5 SOL" },
        { type: "usage", usage: { promptTokens: 1000, completionTokens: 200, totalTokens: 1200 } },
        { type: "done" },
      ]);
      const result = await executeTurn(
        makeContext(), [], null, provider as any, makeConfig() as any, [],
      );

      // Accumulated response is chatCompletion-equivalent…
      expect(result.content).toBe("Bal 2.5 SOL");
      expect(result.toolCalls).toBeNull();
      expect(result.promptTokens).toBe(1000);
      // …without ever touching the buffered path.
      expect(provider.chatCompletion).not.toHaveBeenCalled();

      // …and every chunk was mirrored on the bus, in order, under one stream id.
      expect(events.map((e) => e.deltaType)).toEqual(["text", "text", "usage", "done"]);
      expect(events.map((e) => e.sequence)).toEqual([0, 1, 2, 3]);
      expect(events.every((e) => e.sessionId === "session-1")).toBe(true);
      expect(new Set(events.map((e) => e.streamId)).size).toBe(1);
    } finally {
      off();
    }
  });

  it("emits no stream deltas when the provider cannot stream (buffered fallback)", async () => {
    const events: StreamDeltaEvent[] = [];
    const off = streamDeltaBus.subscribe((e) => events.push(e));
    try {
      const provider = makeProvider({ content: "buffered reply" });
      const result = await executeTurn(
        makeContext(), [], null, provider as any, makeConfig() as any, [],
      );
      expect(result.content).toBe("buffered reply");
      expect(provider.chatCompletion).toHaveBeenCalledTimes(1);
      expect(events).toHaveLength(0);
    } finally {
      off();
    }
  });

  it("aborts before any usage chunk: skips usage logging + token count, flags inferenceAborted (9-5a)", async () => {
    const controller = new AbortController();
    controller.abort();
    const provider = makeStreamingProvider([{ type: "content", text: "x" }]);
    const result = await executeTurn(
      makeContext(), [], null, provider as any, makeConfig() as any, [], {}, controller.signal,
    );

    expect(result.inferenceAborted).toBe(true);
    expect(result.usageObserved).toBe(false);
    // No zero usage row, no token_count reset (context pressure preserved).
    expect(mockLogUsage).not.toHaveBeenCalled();
    expect(mockUpdateTokenCount).not.toHaveBeenCalled();
  });

  it("aborts after a usage chunk: still logs usage + partial content (9-5a)", async () => {
    const controller = new AbortController();
    const provider = {
      id: "fake",
      chatCompletionStream: async function* (): AsyncGenerator<StreamChunk> {
        yield { type: "content", text: "partial" };
        yield { type: "usage", usage: { promptTokens: 1000, completionTokens: 200, totalTokens: 1200 } };
        controller.abort();
        yield { type: "content", text: "DROPPED" };
      },
      chatCompletionSimple: vi.fn(),
      calculateCost: vi.fn().mockReturnValue(COST_RESULT),
    };
    const result = await executeTurn(
      makeContext(), [], null, provider as any, makeConfig() as any, [], {}, controller.signal,
    );

    expect(result.inferenceAborted).toBe(true);
    expect(result.content).toBe("partial");
    expect(result.usageObserved).toBe(true);
    expect(mockLogUsage).toHaveBeenCalled();
  });

  // STRUCTURE+CACHE: executeTurn no longer pre-fetches Active Memory or
  // memory stats — `promptOptions` arrive FULLY BUILT from buildTurnPromptStack
  // (memory façade seam covered by `turn-active-knowledge.test.ts` +
  // `memory/turn-context.test.ts` + `prompts/memory-section.test.ts`).

  // ── D-LAYOUT: 4-segment provider messages + cacheHints ────────

  describe("buildProviderMessages segments + cacheHints", () => {
    function capturedMessages(provider: ReturnType<typeof makeProvider>) {
      const [providerMessages] = provider.chatCompletion.mock.calls[0]!;
      return providerMessages as Array<{
        role: string; content: string; cacheHint?: string; toolCallId?: string;
      }>;
    }

    it("empty history ⇒ [static_prefix, turn_state] with NO history_tail", async () => {
      const provider = makeProvider({ content: "ok" });
      await executeTurn(makeContext(), [], null, provider as any, makeConfig() as any, []);

      const msgs = capturedMessages(provider);
      expect(msgs).toHaveLength(2);
      expect(msgs[0].role).toBe("system");
      expect(msgs[0].cacheHint).toBe("static_prefix");
      expect(msgs[1].role).toBe("system");
      expect(msgs[1].cacheHint).toBe("turn_state");
      expect(msgs.some((m) => m.cacheHint === "history_tail")).toBe(false);
    });

    it("summary present ⇒ second system message carries the 'summary' hint (never a breakpoint hint)", async () => {
      const provider = makeProvider({ content: "ok" });
      await executeTurn(
        makeContext(), [], "rolling summary text", provider as any, makeConfig() as any, [],
      );

      const msgs = capturedMessages(provider);
      expect(msgs[1].role).toBe("system");
      expect(msgs[1].cacheHint).toBe("summary");
      expect(msgs[1].content).toContain("rolling summary text");
    });

    it("marks the LAST history message as history_tail (4 segments in order)", async () => {
      const provider = makeProvider({ content: "ok" });
      const messages = [
        { role: "user" as const, content: "first", timestamp: "t1" },
        { role: "assistant" as const, content: "second", timestamp: "t2" },
      ];
      await executeTurn(
        makeContext(), messages, "summary", provider as any, makeConfig() as any, [],
      );

      const msgs = capturedMessages(provider);
      expect(msgs.map((m) => m.cacheHint)).toEqual([
        "static_prefix", "summary", undefined, "history_tail", "turn_state",
      ]);
    });

    it("tape ending with a continue-cue SYSTEM row: that row is the history_tail (role-agnostic)", async () => {
      const provider = makeProvider({ content: "ok" });
      const messages = [
        { role: "user" as const, content: "go", timestamp: "t1" },
        { role: "system" as const, content: "[Engine: continue]", timestamp: "t2" },
      ];
      await executeTurn(makeContext(), messages, null, provider as any, makeConfig() as any, []);

      const msgs = capturedMessages(provider);
      const tail = msgs.find((m) => m.cacheHint === "history_tail");
      expect(tail?.role).toBe("system");
      expect(tail?.content).toBe("[Engine: continue]");
      // The trailing turn-state system row is NOT the tail.
      expect(msgs[msgs.length - 1].cacheHint).toBe("turn_state");
    });

    it("empty-content tail rows are skipped backwards when marking history_tail", async () => {
      const provider = makeProvider({ content: "ok" });
      const messages = [
        { role: "user" as const, content: "real content", timestamp: "t1" },
        { role: "assistant" as const, content: "", timestamp: "t2" },
      ];
      await executeTurn(makeContext(), messages, null, provider as any, makeConfig() as any, []);

      const msgs = capturedMessages(provider);
      const tail = msgs.find((m) => m.cacheHint === "history_tail");
      expect(tail?.content).toBe("real content");
    });

    it("history_tail is marked AFTER repair: placeholder tool row for an unanswered tool-call becomes the tail", async () => {
      const provider = makeProvider({ content: "ok" });
      const messages = [
        { role: "user" as const, content: "go", timestamp: "t1" },
        {
          role: "assistant" as const,
          content: "",
          toolCalls: [{ id: "call-1", command: "noop", args: {} }],
          timestamp: "t2",
        },
        // NO tool result — repairOrphanedToolCalls appends a placeholder.
      ];
      await executeTurn(makeContext(), messages, null, provider as any, makeConfig() as any, []);

      const msgs = capturedMessages(provider);
      const tail = msgs.find((m) => m.cacheHint === "history_tail");
      expect(tail?.role).toBe("tool");
      expect(tail?.toolCallId).toBe("call-1");
      expect(tail?.content).toContain("placeholder");
    });
  });
});

// ── endpoint failover: cost follows the endpoint that SERVED the turn ──

describe("turn — cost is priced against the switched endpoint (owner decision 7)", () => {
  const SWITCHED = {
    tag: "baidu/fp8",
    providerName: "Baidu",
    uptimePercent: 99.9,
    contextLength: 64_000,
    inputPricePerM: 9,
    outputPricePerM: 33,
    cachePricePerM: null,
    cacheWritePricePerM: null,
    reasoningPricePerM: null,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    resetAllSessionEndpointState();
  });

  function context() {
    return {
      sessionId: "session-switched",
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

  /** Provider shaped like the real one: it exposes its own endpoint catalogue. */
  function providerWithCatalogue() {
    return {
      id: "openrouter",
      chatCompletion: vi.fn().mockResolvedValue({
        content: "done",
        toolCalls: null,
        usage: { promptTokens: 1000, completionTokens: 200 },
      }),
      chatCompletionSimple: vi.fn(),
      calculateCost: vi.fn().mockReturnValue({
        totalCost: 0.05,
        currency: "USD",
        breakdown: { promptCost: 0, completionCost: 0, cachedSavings: 0, reasoningCost: 0 },
      }),
      failoverDeps: () => ({ loadCandidates: async () => [SWITCHED] }),
    };
  }

  const pinnedConfig = {
    provider: "openrouter",
    model: "anthropic/claude-sonnet-4",
    contextLimit: 128_000,
    endpointTag: "deepinfra/fp4",
    maxOutputTokens: 4096,
    inputPricePerM: 3,
    outputPricePerM: 15,
  };

  it("prices the response with the NEW endpoint's rates once the session switched", async () => {
    commitEndpointSwitch("session-switched", SWITCHED.tag);
    const provider = providerWithCatalogue();

    await executeTurn(context(), [], null, provider as any, pinnedConfig as any, []);

    // The pre-send config said 3/15; the endpoint that served it charges 9/33.
    // Pricing against the stale config would put a knowingly wrong number in
    // `usage_log.cost`.
    const pricingConfig = provider.calculateCost.mock.calls[0]?.[1] as {
      inputPricePerM: number;
      outputPricePerM: number;
      endpointTag: string;
    };
    expect(pricingConfig.endpointTag).toBe(SWITCHED.tag);
    expect(pricingConfig.inputPricePerM).toBe(9);
    expect(pricingConfig.outputPricePerM).toBe(33);
  });

  it("uses the operator's own prices when the session never switched", async () => {
    const provider = providerWithCatalogue();
    await executeTurn(context(), [], null, provider as any, pinnedConfig as any, []);

    const pricingConfig = provider.calculateCost.mock.calls[0]?.[1] as {
      inputPricePerM: number;
    };
    expect(pricingConfig.inputPricePerM).toBe(3);
  });
});

// ── Kairos Phase 1: one inference_attempts row per settled attempt ──

describe("turn - inference attempt timing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetAllSessionEndpointState();
  });

  const SECRET_TEXT = "send 4.2 ETH to 0xdeadbeef";
  const SECRET_ARG = "0xfeedface-private-arg";

  function context(missionRunId: string | null = null): EngineContext {
    return {
      sessionId: "session-t",
      sessionKind: "agent",
      sessionPermission: "restricted",
      missionId: null,
      missionRunId,
      selectedEvmWallet: null,
      selectedSolanaWallet: null,
      walletPolicy: { kind: "none" },
      loadedDocuments: new Map<string, string>(),
    };
  }

  function config(extra: Partial<InferenceConfig> = {}): InferenceConfig {
    return {
      provider: "openrouter",
      model: "anthropic/claude-sonnet-4",
      contextLimit: 128000,
      maxOutputTokens: 4096,
      inputPricePerM: 3,
      outputPricePerM: 15,
      priceCurrency: "USD",
      cachePricePerM: null,
      cacheWritePricePerM: null,
      reasoningPricePerM: null,
      supportsReasoningEffort: false,
      ...extra,
    };
  }

  function streaming(chunks: StreamChunk[], opts: { throwAfter?: Error } = {}): InferenceProvider {
    return fakeInferenceProvider({
      chatCompletionStream: async function* (): AsyncGenerator<StreamChunk> {
        for (const chunk of chunks) yield chunk;
        if (opts.throwAfter) throw opts.throwAfter;
      },
      calculateCost: vi.fn<InferenceProvider["calculateCost"]>().mockReturnValue({
        totalCost: 0.001,
        currency: "USD",
        breakdown: { promptCost: 0, completionCost: 0, cachedSavings: 0, reasoningCost: 0 },
      }),
    });
  }

  const TELEMETRY = { turnRunId: "run-1", iteration: 2, preInferenceMs: 3.5, promptStackMs: 1.25 };

  const COMPLETED_CHUNKS: StreamChunk[] = [
    { type: "reasoning", reasoningText: "thinking about " + SECRET_TEXT },
    { type: "content", text: SECRET_TEXT },
    {
      type: "tool_call_delta",
      toolCallIndex: 0,
      toolCallId: "call-1",
      toolCallName: "balance_check",
      toolCallArgsDelta: JSON.stringify({ address: SECRET_ARG }),
    },
    {
      type: "usage",
      usage: {
        promptTokens: 900, completionTokens: 120, totalTokens: 1020,
        cachedTokens: 400, reasoningTokens: 30,
      },
    },
    { type: "done", finishReason: "tool_calls", generationId: "gen-1", servingProvider: "Anthropic" },
  ];

  function recordedRows(): InferenceAttemptRecord[] {
    return mockInsertInferenceAttempt.mock.calls.map((c) => c[0]);
  }

  function expectNoContentLeak(row: InferenceAttemptRecord): void {
    const serialised = JSON.stringify(row);
    expect(serialised).not.toContain("0xdeadbeef");
    expect(serialised).not.toContain(SECRET_ARG);
    expect(serialised).not.toContain("thinking about");
  }

  it("records exactly one completed row and returns the same result as without telemetry", async () => {
    const withoutTelemetry = await executeTurn(
      context(), [], null, streaming(COMPLETED_CHUNKS), config(), [],
    );
    expect(mockInsertInferenceAttempt).not.toHaveBeenCalled();
    expect(mockRecordInBackground).not.toHaveBeenCalled();

    const withTelemetry = await executeTurn(
      context("mrun-1"), [], null, streaming(COMPLETED_CHUNKS), config(), [],
      {}, undefined, undefined, TELEMETRY,
    );

    const { streamId: _a, ...restWith } = withTelemetry;
    const { streamId: _b, ...restWithout } = withoutTelemetry;
    expect(restWith).toEqual(restWithout);

    expect(mockRecordInBackground).toHaveBeenCalledTimes(1);
    expect(mockInsertInferenceAttempt).toHaveBeenCalledTimes(1);
    const row = requireValue(recordedRows()[0]);
    expect(row).toMatchObject({
      sessionId: "session-t",
      missionRunId: "mrun-1",
      turnRunId: "run-1",
      iteration: 2,
      streamId: withTelemetry.streamId,
      outcome: "completed",
      errorClass: null,
      model: "anthropic/claude-sonnet-4",
      servingProvider: "Anthropic",
      requestedEffort: null,
      bufferedFallback: false,
      capacityRetries: 0,
      preInferenceMs: 3.5,
      promptStackMs: 1.25,
      chunkCount: 5,
      finishReason: "tool_calls",
      contentEmpty: false,
      toolCallCount: 1,
      validToolCallCount: 1,
      promptTokens: 900,
      completionTokens: 120,
      reasoningTokens: 30,
      cachedTokens: 400,
      generationId: "gen-1",
    });
    expect(row.startedAt).toBeInstanceOf(Date);
    expect(typeof row.totalMs).toBe("number");
    expect(row.totalMs as number).toBeGreaterThanOrEqual(0);
    expect(row.firstChunkMs as number).toBeGreaterThanOrEqual(0);
    expect(row.firstSemanticMs as number).toBeGreaterThanOrEqual(0);
    expectNoContentLeak(row);
  });

  it("records an aborted row with contentEmpty when the stop landed before any content", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const withoutTelemetry = await executeTurn(
      context(), [], null, streaming(COMPLETED_CHUNKS), config(), [],
      {}, ctrl.signal,
    );
    const result = await executeTurn(
      context(), [], null, streaming(COMPLETED_CHUNKS), config(), [],
      {}, ctrl.signal, undefined, TELEMETRY,
    );

    expect(result.inferenceAborted).toBe(true);
    expect(result.content).toBe(withoutTelemetry.content);
    expect(mockInsertInferenceAttempt).toHaveBeenCalledTimes(1);
    expect(recordedRows()[0]).toMatchObject({
      outcome: "aborted",
      errorClass: null,
      contentEmpty: true,
      chunkCount: 0,
      // No usage chunk arrived, so the token columns stay unknown rather than
      // recording the zero-filled placeholder as a zero-token call.
      promptTokens: null,
      completionTokens: null,
      reasoningTokens: null,
      cachedTokens: null,
    });
  });

  it("records a round a stream bound stopped as timeout / KairosStall and logs no usage", async () => {
    const provider = fakeInferenceProvider({
      chatCompletionStream: async function* (_m, _t, _c, signal): AsyncGenerator<StreamChunk> {
        yield { type: "content", text: "partial" };
        yield {
          type: "tool_call_delta",
          toolCallIndex: 0,
          toolCallId: "call-1",
          toolCallName: "balance_check",
          toolCallArgsDelta: "{}",
        };
        // Then silence, until the idle bound aborts the request.
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
    });
    const result = await executeTurn(
      context(), [], null, provider, config({ streamIdleTimeoutMs: 20 }), [],
      {}, undefined, undefined, TELEMETRY,
    );

    expect(result.timedOut).toBe("idle");
    expect(result.inferenceAborted).toBe(false);
    expect(result.toolCalls).toBeNull();
    expect(result.content).toBe("partial");
    expect(result.finishReason).toBeNull();
    // No usage chunk arrived: nothing to log, and token_count is not reset.
    expect(mockLogUsage).not.toHaveBeenCalled();
    expect(mockUpdateTokenCount).not.toHaveBeenCalled();
    expect(recordedRows()[0]).toMatchObject({
      outcome: "timeout",
      errorClass: "KairosStall:idle",
      toolCallCount: 1,
      validToolCallCount: 0,
      finishReason: null,
    });
  });

  it("a round no bound stopped reports timedOut null", async () => {
    const result = await executeTurn(
      context(), [], null, streaming(COMPLETED_CHUNKS), config({ streamIdleTimeoutMs: 60_000 }), [],
    );
    expect(result.timedOut).toBeNull();
  });

  it("records one error row and rethrows the ORIGINAL error unchanged", async () => {
    const boom = Object.assign(new Error(`upstream said ${SECRET_TEXT}`), {
      name: "ProviderError",
      status: 502,
    });
    const provider = streaming([{ type: "content", text: SECRET_TEXT }], { throwAfter: boom });

    let caught: unknown;
    try {
      await executeTurn(
        context(), [], null, provider, config(), [],
        {}, undefined, undefined, TELEMETRY,
      );
    } catch (err) {
      caught = err;
    }

    expect(caught).toBe(boom);
    expect(mockInsertInferenceAttempt).toHaveBeenCalledTimes(1);
    const row = requireValue(recordedRows()[0]);
    expect(row).toMatchObject({
      outcome: "error",
      errorClass: "ProviderError:status=502",
      servingProvider: null,
      finishReason: null,
      contentEmpty: null,
      promptTokens: null,
      generationId: null,
      chunkCount: 1,
    });
    expectNoContentLeak(row);
    expect(JSON.stringify(row)).not.toContain("upstream said");
    // The turn did not reach usage logging, exactly as without telemetry.
    expect(mockLogUsage).not.toHaveBeenCalled();
  });

  async function recordThrown(err: Error, signal?: AbortSignal): Promise<InferenceAttemptRecord> {
    const provider = streaming([{ type: "content", text: SECRET_TEXT }], { throwAfter: err });
    await expect(
      executeTurn(
        context(), [], null, provider, config(), [],
        {}, signal, undefined, TELEMETRY,
      ),
    ).rejects.toBe(err);
    expect(mockInsertInferenceAttempt).toHaveBeenCalledTimes(1);
    return requireValue(recordedRows()[0]);
  }

  it("records a deadline breach as timeout, not error or aborted", async () => {
    const deadline = AbortSignal.timeout(1);
    await new Promise((r) => setTimeout(r, 5));
    const row = await recordThrown(deadline.reason as Error);
    expect(row).toMatchObject({ outcome: "timeout", errorClass: "TimeoutError" });
  });

  it("records the SDK request timeout as timeout with its class", async () => {
    const sdk = Object.assign(new Error(SECRET_TEXT), { name: "RequestTimeoutError" });
    const row = await recordThrown(sdk);
    expect(row).toMatchObject({ outcome: "timeout", errorClass: "RequestTimeoutError" });
    expectNoContentLeak(row);
  });

  it("records a Stop that lands during a buffered request and throws as aborted", async () => {
    // A buffered request cancelled by the caller rejects rather than returning
    // a partial, so the Stop reaches the recorder as a throw - with the
    // caller's own signal aborted and no deadline involved.
    const live = new AbortController();
    const stopped = Object.assign(new Error("request cancelled"), { name: "RequestAbortedError" });
    const provider = withoutStreamMethod(fakeInferenceProvider({
      ...streaming([]),
      chatCompletion: vi.fn(async () => {
        live.abort();
        throw stopped;
      }),
    }));
    await expect(
      executeTurn(
        context(), [], null, provider, config(), [],
        {}, live.signal, undefined, TELEMETRY,
      ),
    ).rejects.toBe(stopped);
    expect(recordedRows()[0]).toMatchObject({
      outcome: "aborted",
      errorClass: "RequestAbortedError",
    });
  });

  it("a thrown error with the caller's signal untouched stays error", async () => {
    const live = new AbortController();
    const row = await recordThrown(
      Object.assign(new Error("x"), { name: "ProviderError" }),
      live.signal,
    );
    expect(row).toMatchObject({ outcome: "error", errorClass: "ProviderError" });
  });

  it("records the pinned endpoint tag, or NULL when unpinned", async () => {
    await executeTurn(
      context(), [], null, streaming(COMPLETED_CHUNKS),
      config({ endpointTag: "anthropic/fp8" }), [],
      {}, undefined, undefined, TELEMETRY,
    );
    await executeTurn(
      context(), [], null, streaming(COMPLETED_CHUNKS), config(), [],
      {}, undefined, undefined, TELEMETRY,
    );
    expect(recordedRows().map((r) => r.endpointTag)).toEqual(["anthropic/fp8", null]);
  });

  it("records the endpoint the session switched to, not the pre-send pin", async () => {
    commitEndpointSwitch("session-t", "google-vertex");
    const boom = Object.assign(new Error("x"), { name: "ProviderError" });
    const row = await recordThrown(boom);
    // Thrown attempts carry it too - the recorder does no IO to find it.
    expect(row.endpointTag).toBe("google-vertex");
  });

  it("throws the same error with no row when telemetry is absent", async () => {
    const boom = new Error("nope");
    const provider = streaming([{ type: "content", text: "partial" }], { throwAfter: boom });
    await expect(
      executeTurn(context(), [], null, provider, config(), []),
    ).rejects.toBe(boom);
    expect(mockInsertInferenceAttempt).not.toHaveBeenCalled();
    expect(mockRecordInBackground).not.toHaveBeenCalled();
  });

  it("a failing telemetry write never changes the result", async () => {
    mockRecordInBackground.mockImplementationOnce(() => {
      throw new Error("recorder exploded");
    });
    const result = await executeTurn(
      context(), [], null, streaming(COMPLETED_CHUNKS), config(), [],
      {}, undefined, undefined, TELEMETRY,
    );
    expect(result.content).toBe(SECRET_TEXT);
    expect(result.toolCalls).toHaveLength(1);
  });

  it("requestedEffort is null when an effort is chosen but the model does not advertise it", async () => {
    await executeTurn(
      context(), [], null, streaming(COMPLETED_CHUNKS),
      config({ reasoningEffort: "high", supportsReasoningEffort: false }), [],
      {}, undefined, undefined, TELEMETRY,
    );
    expect(recordedRows()[0]?.requestedEffort).toBeNull();
  });

  it("requestedEffort is null when no effort is chosen", async () => {
    await executeTurn(
      context(), [], null, streaming(COMPLETED_CHUNKS),
      config({ supportsReasoningEffort: true }), [],
      {}, undefined, undefined, TELEMETRY,
    );
    expect(recordedRows()[0]?.requestedEffort).toBeNull();
  });

  it("requestedEffort is the effort actually sent when the model advertises it", async () => {
    await executeTurn(
      context(), [], null, streaming(COMPLETED_CHUNKS),
      config({ reasoningEffort: "high", supportsReasoningEffort: true }), [],
      {}, undefined, undefined, TELEMETRY,
    );
    expect(recordedRows()[0]?.requestedEffort).toBe("high");
  });

  it("records the buffered fallback on a provider that cannot stream", async () => {
    const provider = withoutStreamMethod(fakeInferenceProvider({
      chatCompletion: vi.fn().mockResolvedValue({
        content: "  ",
        toolCalls: null,
        usage: { promptTokens: 10, completionTokens: 0 },
        finishReason: "length",
      }),
      calculateCost: vi.fn().mockReturnValue({
        totalCost: 0, currency: "USD",
        breakdown: { promptCost: 0, completionCost: 0, cachedSavings: 0, reasoningCost: 0 },
      }),
    }));
    await executeTurn(
      context(), [], null, provider, config(), [],
      {}, undefined, undefined, TELEMETRY,
    );
    expect(recordedRows()[0]).toMatchObject({
      outcome: "completed",
      bufferedFallback: true,
      fallbackReason: "no_stream_method",
      finishReason: "length",
      contentEmpty: true,
    });
  });
});
