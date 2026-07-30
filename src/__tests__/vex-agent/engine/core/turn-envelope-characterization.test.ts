/**
 * CHARACTERIZATION suite for the request-envelope assembly (rules/03 refactor
 * sequence).
 *
 * Written and proven green BEFORE the assembly moved out of `turn.ts` into
 * `turn-envelope.ts`, then re-run UNCHANGED after the move. It therefore
 * observes only the public entry point (`executeTurn`) and the bytes that
 * reach the provider — never the internal helper names — so it is a genuine
 * before/after equality proof rather than a restatement of the new shape.
 *
 * `turn.test.ts` already covers the individual D-LAYOUT rules. This file adds
 * the WHOLE-envelope golden: one realistic tape exercising summary + user +
 * assistant-with-tool-calls + tool result + an orphaned tool call, asserted as
 * a single structural snapshot so any drift in order, role, content, cache
 * hint, tool-call round-trip or repair placement fails loudly.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@vex-agent/db/repos/messages.js", () => ({
  addMessage: vi.fn(),
  addEngineMessage: vi.fn(),
  getLiveMessages: vi.fn().mockResolvedValue([]),
}));

vi.mock("@vex-agent/db/repos/usage.js", () => ({ logUsage: vi.fn() }));

vi.mock("@vex-agent/db/repos/sessions.js", () => ({
  updateTokenCount: vi.fn(),
  getSession: vi.fn(),
}));

vi.mock("@vex-agent/db/client.js", () => ({
  execute: vi.fn(),
  query: vi.fn().mockResolvedValue([]),
  queryOne: vi.fn().mockResolvedValue(null),
}));

vi.mock("@vex-agent/tools/protocols/catalog.js", () => ({
  PROTOCOL_TOOLS: [],
  PROTOCOL_NAMESPACE_ALLOWLIST: [],
}));

const { executeTurn } = await import("../../../../vex-agent/engine/core/turn.js");

interface CapturedMessage {
  role: string;
  content: string;
  cacheHint?: string;
  toolCallId?: string;
  toolCalls?: Array<{ id: string; command: string; args: Record<string, unknown> }>;
}

describe("turn envelope — characterization (pre/post extraction equality)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function makeContext() {
    return {
      sessionId: "session-envelope",
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

  function makeProvider() {
    return {
      chatCompletion: vi.fn().mockResolvedValue({
        content: "ok",
        toolCalls: null,
        usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 },
      }),
      chatCompletionSimple: vi.fn(),
      calculateCost: vi.fn().mockReturnValue({
        totalCost: 0,
        currency: "USD",
        breakdown: { promptCost: 0, completionCost: 0, cachedSavings: 0, reasoningCost: 0 },
      }),
    };
  }

  /** The tape the envelope is built from — fixed input for the golden. */
  const TAPE = [
    { role: "user" as const, content: "swap 1 SOL", timestamp: "t1" },
    {
      role: "assistant" as const,
      content: "checking",
      toolCalls: [{ id: "call-1", command: "get_quote", args: { amount: "1" } }],
      timestamp: "t2",
    },
    { role: "tool" as const, content: "quote: 1 SOL = 180 USDC", toolCallId: "call-1", timestamp: "t3" },
    {
      role: "assistant" as const,
      content: "",
      // Deliberately UNANSWERED: exercises repairOrphanedToolCalls, and the
      // placeholder it appends must be the history_tail carrier.
      toolCalls: [{ id: "call-2", command: "execute_swap", args: {} }],
      timestamp: "t4",
    },
  ];

  async function captureEnvelope(summary: string | null): Promise<CapturedMessage[]> {
    const provider = makeProvider();
    await executeTurn(
      makeContext(),
      TAPE as never,
      summary,
      provider as never,
      makeConfig() as never,
      [],
    );
    const [providerMessages] = provider.chatCompletion.mock.calls[0]!;
    return providerMessages as CapturedMessage[];
  }

  it("assembles the full envelope: order, roles, hints, tool round-trip, orphan repair", async () => {
    const msgs = await captureEnvelope("earlier context");

    // Segment order + cache-hint layout (D-LAYOUT), whole envelope at once.
    expect(
      msgs.map((m) => ({ role: m.role, cacheHint: m.cacheHint ?? null })),
    ).toEqual([
      { role: "system", cacheHint: "static_prefix" },
      { role: "system", cacheHint: "summary" },
      { role: "user", cacheHint: null },
      { role: "assistant", cacheHint: null },
      { role: "tool", cacheHint: null },
      { role: "assistant", cacheHint: null },
      { role: "tool", cacheHint: "history_tail" },
      { role: "system", cacheHint: "turn_state" },
    ]);

    // Summary segment: prefixed and sanitized-through, not raw-appended.
    expect(msgs[1].content).toContain("[Previous conversation summary]");
    expect(msgs[1].content).toContain("earlier context");

    // History rows are copied verbatim, with tool-call refs round-tripped
    // field-for-field (id/command/args) and toolCallId preserved.
    expect(msgs[2]).toEqual({ role: "user", content: "swap 1 SOL" });
    expect(msgs[3]).toEqual({
      role: "assistant",
      content: "checking",
      toolCalls: [{ id: "call-1", command: "get_quote", args: { amount: "1" } }],
    });
    expect(msgs[4]).toEqual({
      role: "tool",
      content: "quote: 1 SOL = 180 USDC",
      toolCallId: "call-1",
    });

    // The orphan repair placeholder sits immediately after its assistant row
    // and carries the unanswered call id.
    expect(msgs[6].role).toBe("tool");
    expect(msgs[6].toolCallId).toBe("call-2");
    expect(msgs[6].content).toContain("placeholder");
  });

  it("no summary ⇒ the summary segment is absent and history starts at index 1", async () => {
    const msgs = await captureEnvelope(null);

    expect(msgs.map((m) => m.cacheHint ?? null)).toEqual([
      "static_prefix",
      null,
      null,
      null,
      null,
      "history_tail",
      "turn_state",
    ]);
    expect(msgs[1]).toEqual({ role: "user", content: "swap 1 SOL" });
  });

  it("empty-string summary is treated as no summary (truthiness contract)", async () => {
    const msgs = await captureEnvelope("");

    expect(msgs[1].role).toBe("user");
    expect(msgs.some((m) => m.cacheHint === "summary")).toBe(false);
  });

  it("static prefix and turn state are non-empty and distinct segments", async () => {
    const msgs = await captureEnvelope(null);

    expect(msgs[0].content.length).toBeGreaterThan(0);
    expect(msgs[msgs.length - 1].content.length).toBeGreaterThan(0);
    expect(msgs[0].content).not.toBe(msgs[msgs.length - 1].content);
  });
});
