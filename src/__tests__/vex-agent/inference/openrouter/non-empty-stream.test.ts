import { beforeEach, describe, expect, it } from "vitest";

import { requireNonEmptyOpenRouterStream } from "@vex-agent/inference/openrouter/non-empty-stream.js";
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

  it("classifies a usage-and-done-only stream as a synthetic 502", async () => {
    const promise = requireNonEmptyOpenRouterStream(
      fromChunks([
        { type: "usage", usage: { promptTokens: 10, completionTokens: 1, totalTokens: 11 } },
        { type: "done", finishReason: "stop" },
      ]),
    );

    await expect(promise).rejects.toMatchObject({
      message: "OpenRouter streaming chat completion failed: empty response",
      statusCode: 502,
      status: 502,
    });
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
});
