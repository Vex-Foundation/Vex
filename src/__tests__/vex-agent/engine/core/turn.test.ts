import { describe, it, expect, vi, beforeEach } from "vitest";
import type { StreamDeltaEvent } from "../../../../vex-agent/engine/events/index.js";
import type { StreamChunk } from "../../../../vex-agent/inference/types.js";

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
