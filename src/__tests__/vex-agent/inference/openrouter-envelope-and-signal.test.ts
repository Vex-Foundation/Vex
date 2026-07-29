/**
 * Provider composition for the SDK-depth phase: WHICH sends opt into routing
 * metadata, and that every send path can be cancelled.
 *
 * Two separate claims, both about `inference/openrouter.ts` rather than the
 * SDK (the wire-level proof that the envelope field becomes the
 * `X-OpenRouter-Metadata` header lives in `openrouter-wire-request.test.ts`):
 *
 *   1. `xOpenRouterMetadata` rides EXACTLY the two CONVERSATIONAL sends —
 *      `chatCompletion` and `chatCompletionStream`. `chatCompletionSimple`
 *      serves background one-shots (chunker, judge, entity extraction, regime)
 *      which share no prefix with a conversation, so their envelope must stay
 *      byte-identical to what they sent before.
 *   2. `signal` reaches `chat.send`'s `RequestOptions` on ALL THREE paths.
 *      Previously only the streaming call passed one, so a background call
 *      that blew its deadline was abandoned rather than cancelled — it kept
 *      generating, and billing, after we stopped caring.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const sendMock = vi.fn();

vi.mock("@openrouter/sdk", () => ({
  OpenRouter: class {
    readonly models = { list: vi.fn() };
    readonly chat = { send: sendMock };
    readonly credits = {};
    readonly apiKeys = {};
    constructor(_opts: unknown) {}
  },
}));

const loggerMock = vi.hoisted(() => ({
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
  child: vi.fn(),
}));
vi.mock("@utils/logger.js", () => ({
  default: loggerMock,
  logger: loggerMock,
  createChildLogger: () => loggerMock,
}));

const { OpenRouterProvider } = await import("@vex-agent/inference/openrouter.js");

import type {
  InferenceConfig,
  ProviderMessage,
  StreamChunk,
} from "@vex-agent/inference/types.js";

const MESSAGES: ProviderMessage[] = [{ role: "user", content: "hi" }];

function makeConfig(): InferenceConfig {
  return {
    provider: "openrouter",
    model: "deepseek/deepseek-v4-flash",
    contextLimit: 128_000,
    maxOutputTokens: 4096,
    inputPricePerM: 3,
    outputPricePerM: 15,
    priceCurrency: "USD",
    cachePricePerM: null,
    cacheWritePricePerM: null,
    reasoningPricePerM: null,
    supportsReasoningEffort: false,
  };
}

/** A buffered `ChatResult` shaped enough for `parseNonStreamingResponse`. */
function bufferedResult(overrides: Record<string, unknown> = {}) {
  return {
    id: "gen-buffered-1",
    model: "deepseek/deepseek-v4-flash",
    object: "chat.completion",
    created: 1,
    systemFingerprint: "fp",
    choices: [
      { index: 0, finishReason: "stop", message: { role: "assistant", content: "ok" } },
    ],
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    ...overrides,
  };
}

/** An async-iterable stand-in for the SDK's `EventStream`. */
function eventStream(chunks: unknown[]) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    },
  };
}

function envelopeOf(callIndex: number): Record<string, unknown> {
  return sendMock.mock.calls[callIndex][0] as Record<string, unknown>;
}

function optionsOf(callIndex: number): { signal?: AbortSignal } | undefined {
  return sendMock.mock.calls[callIndex][1] as { signal?: AbortSignal } | undefined;
}

async function drain(gen: AsyncGenerator<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = [];
  for await (const chunk of gen) out.push(chunk);
  return out;
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.OPENROUTER_API_KEY = "sk-or-test";
  process.env.AGENT_MODEL = "deepseek/deepseek-v4-flash";
});

describe("routing-metadata opt-in — exactly the two conversational sends", () => {
  it("chatCompletion opts in", async () => {
    sendMock.mockResolvedValueOnce(bufferedResult());
    await new OpenRouterProvider().chatCompletion(MESSAGES, [], makeConfig());

    expect(envelopeOf(0).xOpenRouterMetadata).toBe("enabled");
  });

  it("chatCompletionStream opts in", async () => {
    sendMock.mockResolvedValueOnce(eventStream([]));
    await drain(
      new OpenRouterProvider().chatCompletionStream(MESSAGES, [], makeConfig()),
    );

    expect(envelopeOf(0).xOpenRouterMetadata).toBe("enabled");
  });

  it("chatCompletionSimple does NOT — background envelopes stay unchanged", async () => {
    sendMock.mockResolvedValueOnce(bufferedResult());
    await new OpenRouterProvider().chatCompletionSimple(MESSAGES, makeConfig());

    const envelope = envelopeOf(0);
    expect("xOpenRouterMetadata" in envelope).toBe(false);
    // The envelope carries nothing but the request itself.
    expect(Object.keys(envelope)).toEqual(["chatRequest"]);
  });

  it("keeps the envelope field OUT of chatRequest on every path", async () => {
    // It is a sibling of `chatRequest`, not a member of it. Leaking it into
    // the body would change the prompt-cache key for every turn.
    sendMock.mockResolvedValueOnce(bufferedResult());
    await new OpenRouterProvider().chatCompletion(MESSAGES, [], makeConfig());

    const chatRequest = envelopeOf(0).chatRequest as Record<string, unknown>;
    expect("xOpenRouterMetadata" in chatRequest).toBe(false);
  });
});

/**
 * Cancellation is asserted BEHAVIOURALLY (the forwarded signal aborts when the
 * caller aborts), not by object identity. The signal handed to the SDK is
 * deliberately no longer the caller's own: it is composed with the client's
 * configured deadline, because supplying a raw signal suppresses that deadline
 * entirely. That composition — and the ceiling it restores — is pinned in
 * `openrouter-request-deadline.test.ts`.
 */
function assertCancels(signal: AbortSignal | undefined, controller: AbortController): void {
  expect(signal).toBeDefined();
  expect(signal?.aborted).toBe(false);
  controller.abort();
  expect(signal?.aborted).toBe(true);
}

describe("cancellation reaches chat.send on every path", () => {
  it("chatCompletion forwards a signal that the caller can abort", async () => {
    sendMock.mockResolvedValueOnce(bufferedResult());
    const controller = new AbortController();
    await new OpenRouterProvider().chatCompletion(
      MESSAGES,
      [],
      makeConfig(),
      undefined,
      controller.signal,
    );

    assertCancels(optionsOf(0)?.signal, controller);
  });

  it("chatCompletionSimple forwards the signal (4th arg, after responseFormat)", async () => {
    sendMock.mockResolvedValueOnce(bufferedResult());
    const controller = new AbortController();
    await new OpenRouterProvider().chatCompletionSimple(
      MESSAGES,
      makeConfig(),
      undefined,
      controller.signal,
    );

    assertCancels(optionsOf(0)?.signal, controller);
  });

  it("chatCompletionStream forwards a signal that the caller can abort", async () => {
    sendMock.mockResolvedValueOnce(eventStream([]));
    const controller = new AbortController();
    await drain(
      new OpenRouterProvider().chatCompletionStream(
        MESSAGES,
        [],
        makeConfig(),
        controller.signal,
      ),
    );

    assertCancels(optionsOf(0)?.signal, controller);
  });

  it("passes NO options object when no signal is supplied", async () => {
    // Keeps the call byte-identical for callers that use no new feature.
    sendMock.mockResolvedValueOnce(bufferedResult());
    await new OpenRouterProvider().chatCompletionSimple(MESSAGES, makeConfig());

    expect(optionsOf(0)).toBeUndefined();
  });
});

describe("buffered path carries provider provenance", () => {
  it("reads finishReason and generationId off the ChatResult", async () => {
    sendMock.mockResolvedValueOnce(bufferedResult());
    const res = await new OpenRouterProvider().chatCompletion(
      MESSAGES,
      [],
      makeConfig(),
    );

    expect(res.finishReason).toBe("stop");
    expect(res.generationId).toBe("gen-buffered-1");
  });

  it("carries an unenumerated finish reason verbatim (open enum)", async () => {
    sendMock.mockResolvedValueOnce(
      bufferedResult({
        choices: [
          {
            index: 0,
            finishReason: "some_future_reason",
            message: { role: "assistant", content: "ok" },
          },
        ],
      }),
    );
    const res = await new OpenRouterProvider().chatCompletion(
      MESSAGES,
      [],
      makeConfig(),
    );

    expect(res.finishReason).toBe("some_future_reason");
  });

  it("reports null — not a truncated prefix — for an implausibly long generation id", async () => {
    // A sliced id would not match anything in OpenRouter's activity log yet
    // would look authoritative in `usage_log.generation_id`.
    sendMock.mockResolvedValueOnce(bufferedResult({ id: "g".repeat(500) }));
    const res = await new OpenRouterProvider().chatCompletion(
      MESSAGES,
      [],
      makeConfig(),
    );

    expect(res.generationId).toBeNull();
  });
});
