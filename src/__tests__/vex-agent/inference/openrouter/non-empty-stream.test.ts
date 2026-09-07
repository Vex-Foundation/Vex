import { beforeEach, describe, expect, it } from "vitest";

import {
  MAX_EMPTY_PREFIX_BYTES,
  MAX_EMPTY_PREFIX_CHUNKS,
  OpenRouterEmptyStreamError,
  requireNonEmptyOpenRouterStream,
} from "@vex-agent/inference/openrouter/non-empty-stream.js";
import {
  resetAllSessionEndpointState,
  sendWithEndpointFailover,
} from "@vex-agent/inference/openrouter/endpoint-failover.js";
import type {
  EndpointCandidate,
  InferenceConfig,
  StreamChunk,
} from "@vex-agent/inference/types.js";

async function* fromChunks(
  chunks: readonly StreamChunk[],
): AsyncGenerator<StreamChunk> {
  for (const chunk of chunks) yield chunk;
}

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

interface ControlledSource {
  readonly iterable: AsyncIterable<StreamChunk>;
  /** How many times the consumer asked the provider for another chunk. */
  readonly pulls: () => number;
  /** How many times the consumer released the source. */
  readonly returns: () => number;
}

/**
 * A hand-written async iterable (not a generator) so the test can OBSERVE
 * `return()` - the release the module owes on every exit path - and count
 * pulls without a timer. `onPull` runs before each chunk is handed over, which
 * is how the abort test lands a Stop in the middle of buffering with no sleep
 * anywhere.
 */
function controlledSource(
  chunks: readonly StreamChunk[],
  options: { readonly onPull?: (index: number) => void; readonly failAt?: number } = {},
): ControlledSource {
  let index = 0;
  let pulls = 0;
  let returns = 0;
  const iterable: AsyncIterable<StreamChunk> = {
    [Symbol.asyncIterator]: () => ({
      next: async (): Promise<IteratorResult<StreamChunk>> => {
        options.onPull?.(pulls);
        pulls += 1;
        if (options.failAt !== undefined && index === options.failAt) {
          throw new Error("upstream disconnected");
        }
        if (index >= chunks.length) {
          return { done: true, value: undefined } as IteratorResult<StreamChunk>;
        }
        const value = chunks[index];
        index += 1;
        return { done: false, value };
      },
      return: async (): Promise<IteratorResult<StreamChunk>> => {
        returns += 1;
        return { done: true, value: undefined } as IteratorResult<StreamChunk>;
      },
    }),
  };
  return { iterable, pulls: () => pulls, returns: () => returns };
}

/** A chunk that carries no meaningful delta: whitespace only. */
function blankChunk(): StreamChunk {
  return { type: "content", text: " " };
}

describe("requireNonEmptyOpenRouterStream", () => {
  beforeEach(() => resetAllSessionEndpointState());

  it("replays the buffered prefix and preserves the rest of a healthy stream", async () => {
    const input: StreamChunk[] = [
      { type: "usage", usage: { promptTokens: 10, completionTokens: 1, totalTokens: 11 } },
      { type: "content", text: "ready" },
      { type: "done", finishReason: "stop" },
    ];

    const validated = await requireNonEmptyOpenRouterStream(fromChunks(input));
    await expect(collect(validated)).resolves.toEqual(input);
  });

  it("replays EXACTLY the buffered prefix, in order, then continues live", async () => {
    const prefix: StreamChunk[] = [
      { type: "usage", usage: { promptTokens: 10, completionTokens: 1, totalTokens: 11 } },
      { type: "content", text: "  " },
      { type: "content", text: "\n" },
    ];
    const live: StreamChunk[] = [
      { type: "content", text: "first" },
      { type: "content", text: " second" },
      { type: "done", finishReason: "stop" },
    ];
    const source = controlledSource([...prefix, ...live]);

    const validated = await requireNonEmptyOpenRouterStream(source.iterable);
    // Buffering stopped at the first meaningful delta: four pulls, not six.
    expect(source.pulls()).toBe(4);

    await expect(collect(validated)).resolves.toEqual([...prefix, ...live]);
    expect(source.returns()).toBe(1);
  });

  it("classifies a usage-and-done-only stream as a synthetic 502", async () => {
    const promise = requireNonEmptyOpenRouterStream(
      fromChunks([
        { type: "usage", usage: { promptTokens: 10, completionTokens: 1, totalTokens: 11 } },
        { type: "done", finishReason: "stop" },
      ]),
    );

    await expect(promise).rejects.toMatchObject({
      message: "OpenRouter streaming chat completion failed: empty response",
      reason: "stream_exhausted",
      statusCode: 502,
      status: 502,
    });
  });

  it("releases the source when the stream ends without a meaningful delta", async () => {
    const source = controlledSource([{ type: "done", finishReason: "stop" }]);

    await expect(
      requireNonEmptyOpenRouterStream(source.iterable),
    ).rejects.toBeInstanceOf(OpenRouterEmptyStreamError);
    expect(source.returns()).toBe(1);
  });

  it("fails at the CHUNK bound instead of buffering an endless blank prefix", async () => {
    const blanks = Array.from({ length: MAX_EMPTY_PREFIX_CHUNKS + 1 }, blankChunk);
    const source = controlledSource([
      ...blanks,
      { type: "content", text: "never reached" },
    ]);

    const error = await requireNonEmptyOpenRouterStream(source.iterable).catch(
      (err: unknown) => err,
    );

    expect(error).toBeInstanceOf(OpenRouterEmptyStreamError);
    const typed = error as OpenRouterEmptyStreamError;
    expect(typed.reason).toBe("prefix_bound_exceeded");
    expect(typed.chunksSeen).toBe(MAX_EMPTY_PREFIX_CHUNKS);
    expect(typed.maxChunks).toBe(MAX_EMPTY_PREFIX_CHUNKS);
    expect(typed.maxBytes).toBe(MAX_EMPTY_PREFIX_BYTES);
    // The bound and the counts are IN the message, never a generic error.
    expect(typed.message).toContain(`bound ${MAX_EMPTY_PREFIX_CHUNKS} chunks`);
    expect(typed.message).toContain(`seen ${MAX_EMPTY_PREFIX_CHUNKS} chunks`);
    // Retryable through the existing capacity policy.
    expect(typed).toMatchObject({ statusCode: 502, status: 502 });
    // Stopped pulling at the bound, and released the source.
    expect(source.pulls()).toBe(MAX_EMPTY_PREFIX_CHUNKS + 1);
    expect(source.returns()).toBe(1);
  });

  it("fails at the BYTE bound even when the chunk count stays low", async () => {
    const halfBound = " ".repeat(MAX_EMPTY_PREFIX_BYTES / 2);
    const source = controlledSource([
      { type: "content", text: halfBound },
      { type: "content", text: halfBound },
      { type: "content", text: halfBound },
      { type: "content", text: "never reached" },
    ]);

    const error = await requireNonEmptyOpenRouterStream(source.iterable).catch(
      (err: unknown) => err,
    );

    expect(error).toBeInstanceOf(OpenRouterEmptyStreamError);
    const typed = error as OpenRouterEmptyStreamError;
    expect(typed.reason).toBe("prefix_bound_exceeded");
    expect(typed.chunksSeen).toBe(2);
    expect(typed.chunksSeen).toBeLessThan(MAX_EMPTY_PREFIX_CHUNKS);
    expect(typed.bytesSeen).toBe(MAX_EMPTY_PREFIX_BYTES);
    expect(typed.message).toContain(`${MAX_EMPTY_PREFIX_BYTES} bytes`);
    expect(source.pulls()).toBe(3);
    expect(source.returns()).toBe(1);
  });

  it("accepts a prefix that sits exactly ON the bound", async () => {
    const blanks = Array.from({ length: MAX_EMPTY_PREFIX_CHUNKS }, blankChunk);
    const tail: StreamChunk[] = [
      { type: "content", text: "answer" },
      { type: "done", finishReason: "stop" },
    ];
    const source = controlledSource([...blanks, ...tail]);

    const validated = await requireNonEmptyOpenRouterStream(source.iterable);
    await expect(collect(validated)).resolves.toEqual([...blanks, ...tail]);
  });

  it("releases the source and rethrows the signal's reason when the caller aborts", async () => {
    const controller = new AbortController();
    const source = controlledSource([blankChunk(), blankChunk()], {
      // The Stop lands after the first chunk was buffered, deterministically.
      onPull: (index) => {
        if (index === 1) controller.abort();
      },
    });

    const error = await requireNonEmptyOpenRouterStream(
      source.iterable,
      controller.signal,
    ).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).toBe("AbortError");
    expect(source.returns()).toBe(1);
    // Two pulls happened; the third never did, because the loop checked the
    // signal before asking for more.
    expect(source.pulls()).toBe(2);
  });

  it("releases the source when the upstream rejects and preserves that failure", async () => {
    const source = controlledSource([blankChunk()], { failAt: 1 });

    await expect(
      requireNonEmptyOpenRouterStream(source.iterable),
    ).rejects.toThrow("upstream disconnected");
    expect(source.returns()).toBe(1);
  });

  it("accepts reasoning as a streamed signal but leaves final validation to the consumer", async () => {
    const input: StreamChunk[] = [
      { type: "reasoning", reasoningText: "checking" },
      { type: "done", finishReason: "stop" },
    ];

    const validated = await requireNonEmptyOpenRouterStream(fromChunks(input));
    await expect(collect(validated)).resolves.toEqual(input);
  });

  it("does not reroute an empty content-filter termination", async () => {
    const input: StreamChunk[] = [
      { type: "done", finishReason: "content_filter" },
    ];

    const validated = await requireNonEmptyOpenRouterStream(fromChunks(input));
    await expect(collect(validated)).resolves.toEqual(input);
  });

  it("feeds empty streams into bounded endpoint failover and returns the healthy sibling", async () => {
    const candidates: EndpointCandidate[] = [
      {
        tag: "streamlake/fp8",
        providerName: "StreamLake",
        uptimePercent: 90,
        contextLength: 128_000,
        inputPricePerM: 1,
        outputPricePerM: 1,
        cachePricePerM: null,
        cacheWritePricePerM: null,
        reasoningPricePerM: null,
      },
      {
        tag: "healthy/fp8",
        providerName: "Healthy",
        uptimePercent: 99.9,
        contextLength: 128_000,
        inputPricePerM: 1,
        outputPricePerM: 1,
        cachePricePerM: null,
        cacheWritePricePerM: null,
        reasoningPricePerM: null,
      },
    ];
    const config: InferenceConfig = {
      provider: "openrouter",
      model: "deepseek/deepseek-v4-pro",
      contextLimit: 128_000,
      endpointTag: "streamlake/fp8",
      endpointCandidates: candidates,
      maxOutputTokens: 4096,
      inputPricePerM: 1,
      outputPricePerM: 1,
      priceCurrency: "USD",
      cachePricePerM: null,
      cacheWritePricePerM: null,
      reasoningPricePerM: null,
      supportsReasoningEffort: true,
    };
    const attemptedTags: Array<string | undefined> = [];

    const validated = await sendWithEndpointFailover(
      async (attemptConfig) => {
        attemptedTags.push(attemptConfig.endpointTag);
        if (attemptConfig.endpointTag === "healthy/fp8") {
          return requireNonEmptyOpenRouterStream(
            fromChunks([
              { type: "content", text: "ready" },
              { type: "done", finishReason: "stop" },
            ]),
          );
        }
        return requireNonEmptyOpenRouterStream(
          fromChunks([{ type: "done", finishReason: "stop" }]),
        );
      },
      config,
      { sessionId: "empty-stream-failover", missionRunId: null },
      {
        loadCandidates: async () => candidates,
        sleep: async () => undefined,
        loadPersistedSwitch: async () => null,
        persistSwitch: async () => undefined,
      },
    );

    await expect(collect(validated)).resolves.toEqual([
      { type: "content", text: "ready" },
      { type: "done", finishReason: "stop" },
    ]);
    expect(attemptedTags).toEqual([
      "streamlake/fp8",
      "streamlake/fp8",
      "healthy/fp8",
    ]);
  });

  it("routes a bound-exceeded prefix through the same failover policy", async () => {
    const blanks = Array.from({ length: MAX_EMPTY_PREFIX_CHUNKS + 1 }, blankChunk);
    const candidates: EndpointCandidate[] = [
      {
        tag: "blank/fp8",
        providerName: "Blank",
        uptimePercent: 90,
        contextLength: 128_000,
        inputPricePerM: 1,
        outputPricePerM: 1,
        cachePricePerM: null,
        cacheWritePricePerM: null,
        reasoningPricePerM: null,
      },
      {
        tag: "healthy/fp8",
        providerName: "Healthy",
        uptimePercent: 99.9,
        contextLength: 128_000,
        inputPricePerM: 1,
        outputPricePerM: 1,
        cachePricePerM: null,
        cacheWritePricePerM: null,
        reasoningPricePerM: null,
      },
    ];
    const config: InferenceConfig = {
      provider: "openrouter",
      model: "deepseek/deepseek-v4-pro",
      contextLimit: 128_000,
      endpointTag: "blank/fp8",
      endpointCandidates: candidates,
      maxOutputTokens: 4096,
      inputPricePerM: 1,
      outputPricePerM: 1,
      priceCurrency: "USD",
      cachePricePerM: null,
      cacheWritePricePerM: null,
      reasoningPricePerM: null,
      supportsReasoningEffort: true,
    };
    const attemptedTags: Array<string | undefined> = [];

    const validated = await sendWithEndpointFailover(
      async (attemptConfig) => {
        attemptedTags.push(attemptConfig.endpointTag);
        if (attemptConfig.endpointTag === "healthy/fp8") {
          return requireNonEmptyOpenRouterStream(
            fromChunks([
              { type: "content", text: "ready" },
              { type: "done", finishReason: "stop" },
            ]),
          );
        }
        return requireNonEmptyOpenRouterStream(fromChunks(blanks));
      },
      config,
      { sessionId: "bounded-prefix-failover", missionRunId: null },
      {
        loadCandidates: async () => candidates,
        sleep: async () => undefined,
        loadPersistedSwitch: async () => null,
        persistSwitch: async () => undefined,
      },
    );

    await expect(collect(validated)).resolves.toEqual([
      { type: "content", text: "ready" },
      { type: "done", finishReason: "stop" },
    ]);
    expect(attemptedTags).toEqual(["blank/fp8", "blank/fp8", "healthy/fp8"]);
  });
});
