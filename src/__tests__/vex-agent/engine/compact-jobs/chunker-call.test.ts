/**
 * `callChunkerLLM` — provider injection, per-call deadline, and the cost/model
 * audit data the executor persists on `compact_jobs`.
 *
 * The provider is now injectable through the same structural `JudgeProvider`
 * its three background siblings already use, so this suite drives it with a
 * deterministic stub and never touches a live OpenRouter.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { callChunkerLLM } from "@vex-agent/engine/compact-jobs/chunker-call.js";
import { CHUNKER_CALL_TIMEOUT_MS } from "@vex-agent/engine/compact-jobs/policy.js";
import type { JudgeProvider } from "@vex-agent/memory/manager/judge.js";
import type { CompactJob } from "@vex-agent/db/repos/compact-jobs/index.js";
import type { ArchivedPrefixRow } from "@vex-agent/engine/compact-jobs/archived-prefix.js";

const VALID_OUTPUT = JSON.stringify({
  chunks: [{ theme: "kyber_quote_timeout_pattern", happened_md: "it timed out" }],
});

function job(): CompactJob {
  return {
    id: 1,
    sessionId: "session-1",
    checkpointGeneration: 3,
    agentSummary: "a summary",
    preserveMd: null,
    threadThemesHints: [],
    sourceStartMessageId: 1,
    sourceEndMessageId: 2,
    attemptCount: 0,
  } as unknown as CompactJob;
}

const PREFIX: ArchivedPrefixRow[] = [
  { role: "user", content: "hello" } as unknown as ArchivedPrefixRow,
];

/** Records what the chunker passed to the provider. */
interface StubCall {
  readonly responseFormat: unknown;
  readonly signal: AbortSignal | undefined;
}

function stubProvider(options: {
  content?: string;
  cost?: number | null;
  model?: string | null;
  onCall?: (call: StubCall) => void;
  behaviour?: (signal: AbortSignal | undefined) => Promise<never>;
}): () => Promise<JudgeProvider> {
  return async () => ({
    loadConfig: async () =>
      options.model === null ? {} : { model: options.model ?? "deepseek/deepseek-v4-flash" },
    chatCompletionSimple: async (
      _messages: ReadonlyArray<{ role: string; content: string }>,
      _config: unknown,
      responseFormat?: unknown,
      signal?: AbortSignal,
    ) => {
      options.onCall?.({ responseFormat, signal });
      if (options.behaviour) return options.behaviour(signal);
      return {
        content: options.content ?? VALID_OUTPUT,
        usage: { cost: options.cost === undefined ? 0.00042 : options.cost },
      };
    },
  });
}

beforeEach(() => {
  process.env.OPENROUTER_API_KEY = "sk-or-test";
  process.env.AGENT_MODEL = "deepseek/deepseek-v4-flash";
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("callChunkerLLM — injection", () => {
  it("uses the injected provider instead of constructing a live one", async () => {
    let called = false;
    const result = await callChunkerLLM(
      job(),
      PREFIX,
      stubProvider({ onCall: () => { called = true; } }),
    );

    expect(called).toBe(true);
    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0].theme).toBe("kyber_quote_timeout_pattern");
  });

  it("still throws (never returns []) when the config cannot load", async () => {
    // Returning an empty array would let `markCompleted(0 chunks)` silently
    // lose the job — the permanent-loss bug this guard exists for.
    const provider: () => Promise<JudgeProvider> = async () => ({
      loadConfig: async () => null,
      chatCompletionSimple: async () => ({ content: VALID_OUTPUT }),
    });

    await expect(callChunkerLLM(job(), PREFIX, provider)).rejects.toThrow(
      "compact_worker_provider_config_load_failed",
    );
  });

  it("throws before touching the provider when env is missing", async () => {
    delete process.env.OPENROUTER_API_KEY;
    let called = false;

    await expect(
      callChunkerLLM(job(), PREFIX, stubProvider({ onCall: () => { called = true; } })),
    ).rejects.toThrow("compact_worker_provider_config_missing");
    expect(called).toBe(false);
  });
});

describe("callChunkerLLM — per-call deadline", () => {
  it("passes an AbortSignal so an overdue request is cancelled, not abandoned", async () => {
    let seen: AbortSignal | undefined;
    await callChunkerLLM(
      job(),
      PREFIX,
      stubProvider({ onCall: (call) => { seen = call.signal; } }),
    );

    expect(seen).toBeInstanceOf(AbortSignal);
    expect(seen?.aborted).toBe(false);
  });

  it("reports the named chunker_timeout when the deadline fired", async () => {
    // Simulate the SDK rejecting because our signal aborted the fetch. The
    // named error is what the retry/backoff logging keys on; the raw abort
    // error would only say "aborted".
    const provider = stubProvider({
      behaviour: async (signal) => {
        Object.defineProperty(signal, "aborted", { value: true, configurable: true });
        throw new Error("This operation was aborted");
      },
    });

    await expect(callChunkerLLM(job(), PREFIX, provider)).rejects.toThrow("chunker_timeout");
  });

  it("propagates a NON-timeout provider failure unchanged", async () => {
    const provider = stubProvider({
      behaviour: async () => {
        throw new Error("OpenRouter simple chat completion failed: status=402");
      },
    });

    await expect(callChunkerLLM(job(), PREFIX, provider)).rejects.toThrow("status=402");
  });

  it("keeps the deadline above the SDK's own retry envelope and below the stale threshold", () => {
    // 60s is the client's `maxElapsedTime`; 120s is WORKER_STALE_THRESHOLD_MS.
    // Sitting between them is what stops a legitimate SDK retry from being
    // cut short AND stops an in-flight call looking like a dead worker.
    expect(CHUNKER_CALL_TIMEOUT_MS).toBeGreaterThan(60_000);
    expect(CHUNKER_CALL_TIMEOUT_MS).toBeLessThan(120_000);
  });
});

describe("callChunkerLLM — cost and model audit", () => {
  it("returns the provider-reported cost and the resolved model", async () => {
    const result = await callChunkerLLM(
      job(),
      PREFIX,
      stubProvider({ cost: 0.0031, model: "anthropic/claude-sonnet-4" }),
    );

    expect(result.costUsd).toBe(0.0031);
    expect(result.model).toBe("anthropic/claude-sonnet-4");
  });

  it("reports null cost when the provider did not report one", async () => {
    const result = await callChunkerLLM(job(), PREFIX, stubProvider({ cost: null }));

    expect(result.costUsd).toBeNull();
  });

  it("reports null model when the config carries no readable model", async () => {
    const result = await callChunkerLLM(job(), PREFIX, stubProvider({ model: null }));

    expect(result.model).toBeNull();
  });

  it("still surfaces a malformed response as a throw, not a silent empty result", async () => {
    await expect(
      callChunkerLLM(job(), PREFIX, stubProvider({ content: "no json here" })),
    ).rejects.toThrow("chunker_malformed_json");
  });
});
