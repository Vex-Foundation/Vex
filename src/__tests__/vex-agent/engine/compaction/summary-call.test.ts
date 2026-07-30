/**
 * Branch-A inference call — the MESSAGE SHAPE, provider injection, the
 * fresh-per-call contract, the deadline, and the failure vocabulary the retry
 * path keys on.
 *
 * The shape assertions are the load-bearing ones: the branch forks from the
 * tape, so what goes on the wire is the branch system prompt, then the frozen
 * prefix verbatim WITH its roles and tool pairing, then the instruction as the
 * final user turn. Flattening any of that back into one user message is the
 * regression these tests exist to catch.
 *
 * The provider is driven by a deterministic stub; nothing here touches a live
 * OpenRouter.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import type { ProviderMessage } from "@vex-agent/inference/types.js";
import type { BranchInferenceProvider } from "@vex-agent/engine/compaction/branch-provider-call.js";
import { callSummaryLLM } from "@vex-agent/engine/compaction/summary-call.js";
import { SUMMARY_CALL_TIMEOUT_MS } from "@vex-agent/engine/compaction/policy.js";
import { buildSummarySystemPrompt } from "@vex-agent/engine/compaction/summary-prompt.js";

/** A frozen prefix with a real assistant→tool pair in it. */
const PREFIX: ProviderMessage[] = [
  { role: "user", content: "what did the quote say" },
  {
    role: "assistant",
    content: "quoting",
    toolCalls: [{ id: "call-1", command: "kyber_quote", args: { from: "SOL" } }],
  },
  { role: "tool", content: "quote returned", toolCallId: "call-1" },
];

const INPUT = {
  preparationId: 11,
  sessionId: "session-1",
  frozenSummary: "previous history",
  prefix: PREFIX,
};

function stubProvider(
  content: string,
  overrides: Partial<BranchInferenceProvider> = {},
): BranchInferenceProvider {
  return {
    loadConfig: async () => ({ model: "test/model" }),
    chatCompletionSimple: async () => ({
      content,
      usage: { cost: 0.0007 },
    }),
    ...overrides,
  };
}

const VALID = JSON.stringify({ conversation_summary: "the user wants swaps" });

describe("callSummaryLLM", () => {
  const originalKey = process.env.OPENROUTER_API_KEY;
  const originalModel = process.env.AGENT_MODEL;

  beforeEach(() => {
    process.env.OPENROUTER_API_KEY = "test-key";
    process.env.AGENT_MODEL = "test/model";
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = originalKey;
    if (originalModel === undefined) delete process.env.AGENT_MODEL;
    else process.env.AGENT_MODEL = originalModel;
  });

  async function capturedMessages(): Promise<ProviderMessage[]> {
    const chatCompletionSimple = vi.fn(async () => ({ content: VALID }));
    await callSummaryLLM(INPUT, async () =>
      stubProvider(VALID, { chatCompletionSimple }),
    );
    return (chatCompletionSimple.mock.calls[0]?.[0] ?? []) as ProviderMessage[];
  }

  it("sends the frozen prefix VERBATIM, roles and tool pairing intact", async () => {
    const messages = await capturedMessages();

    expect(messages.map((m) => m.role)).toEqual([
      "system",
      "user",
      "assistant",
      "tool",
      "user",
    ]);
    // The prefix is replayed as-is — not summarised, not flattened.
    expect(messages.slice(1, 4)).toEqual(PREFIX);
    expect(messages[2]?.toolCalls?.[0]?.id).toBe("call-1");
    expect(messages[3]?.toolCallId).toBe("call-1");
  });

  it("puts the branch system prompt first and the instruction LAST", async () => {
    const messages = await capturedMessages();

    expect(messages[0]).toEqual({
      role: "system",
      content: buildSummarySystemPrompt(),
    });
    const last = messages.at(-1);
    expect(last?.role).toBe("user");
    expect(last?.content).toMatch(/conversation above/i);
    // The frozen summary is not on the tape, so it rides the instruction turn.
    expect(last?.content).toContain("previous history");
  });

  it("does not smuggle the conversation into the instruction turn", async () => {
    const messages = await capturedMessages();
    const last = messages.at(-1);

    // The v1 shape inlined the whole window here. If it ever comes back, the
    // prefix would be sent twice and the provider cache prefix would be lost.
    expect(last?.content).not.toContain("what did the quote say");
    expect(last?.content).not.toContain("[user]");
  });

  it("sends NO tool definitions — a branch never executes anything", async () => {
    const chatCompletionSimple = vi.fn(async () => ({ content: VALID }));
    await callSummaryLLM(INPUT, async () =>
      stubProvider(VALID, { chatCompletionSimple }),
    );
    // `chatCompletionSimple` is the no-tools entry point; the third argument is
    // the optional response format and is deliberately unset.
    expect(chatCompletionSimple.mock.calls[0]?.[2]).toBeUndefined();
  });

  it("returns the raw summary plus the cost and model audit data", async () => {
    const result = await callSummaryLLM(INPUT, async () => stubProvider(VALID));
    expect(result).toEqual({
      rawSummary: "the user wants swaps",
      costUsd: 0.0007,
      model: "test/model",
    });
  });

  it("constructs a FRESH provider on every call", async () => {
    // The constructor reads the vault-populated env vars, so a cached provider
    // would pin stale credentials across an unlock/lock cycle.
    const factory = vi.fn(async () => stubProvider(VALID));
    await callSummaryLLM(INPUT, factory);
    await callSummaryLLM(INPUT, factory);
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it("passes the per-call deadline as a real AbortSignal", async () => {
    const chatCompletionSimple = vi.fn(async () => ({ content: VALID }));
    await callSummaryLLM(INPUT, async () =>
      stubProvider(VALID, { chatCompletionSimple }),
    );
    const signal = chatCompletionSimple.mock.calls[0]?.[3] as
      | AbortSignal
      | undefined;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(SUMMARY_CALL_TIMEOUT_MS).toBe(90_000);
  });

  it("THROWS when the vault has not populated the provider config", async () => {
    delete process.env.OPENROUTER_API_KEY;
    const factory = vi.fn(async () => stubProvider(VALID));
    // Throwing (not returning empty) is what makes this a failed attempt with a
    // backoff instead of a silently-successful empty summary.
    await expect(callSummaryLLM(INPUT, factory)).rejects.toThrow(
      "compaction_summary_provider_config_missing",
    );
    expect(factory).not.toHaveBeenCalled();
  });

  it("THROWS when the provider config cannot be loaded", async () => {
    await expect(
      callSummaryLLM(INPUT, async () =>
        stubProvider(VALID, { loadConfig: async () => null }),
      ),
    ).rejects.toThrow("compaction_summary_provider_config_load_failed");
  });

  it("THROWS a named error on output with no JSON object in it", async () => {
    await expect(
      callSummaryLLM(INPUT, async () => stubProvider("no braces here")),
    ).rejects.toThrow("compaction_summary_malformed_json");
  });

  it("THROWS a named error on schema-invalid output", async () => {
    await expect(
      callSummaryLLM(INPUT, async () =>
        stubProvider(JSON.stringify({ summary: "wrong key" })),
      ),
    ).rejects.toThrow("compaction_summary_schema_invalid");
  });

  it("surfaces a cancelled call as compaction_summary_timeout", async () => {
    // The deadline is 90s, so it is forced rather than waited for: an
    // already-aborted signal reproduces exactly the state the real deadline
    // leaves behind. The SDK's own abort error says nothing about WHY the
    // request was cancelled, which is why the named error exists.
    const spy = vi
      .spyOn(AbortSignal, "timeout")
      .mockReturnValue(AbortSignal.abort());
    try {
      await expect(
        callSummaryLLM(INPUT, async () =>
          stubProvider(VALID, {
            chatCompletionSimple: async () => {
              throw new Error("The operation was aborted");
            },
          }),
        ),
      ).rejects.toThrow("compaction_summary_timeout");
    } finally {
      spy.mockRestore();
    }
  });

  it("propagates a non-timeout provider error unchanged", async () => {
    await expect(
      callSummaryLLM(INPUT, async () =>
        stubProvider(VALID, {
          chatCompletionSimple: async () => {
            throw new Error("provider_429");
          },
        }),
      ),
    ).rejects.toThrow("provider_429");
  });
});
