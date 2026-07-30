/**
 * `consumeOpenRouterStream` — the SDK-chunk → `StreamChunk` mapping for the
 * provider signals the runtime used to discard, plus the bounded routing
 * summary.
 *
 * Covers what the provider-agnostic `stream-consumer.test.ts` cannot: this is
 * the layer that reads the SDK's own chunk shape (`choices[0].finishReason`,
 * `error.metadata.errorType`, chunk `id`, `openrouterMetadata`).
 */

import { describe, it, expect } from "vitest";

import type { ChatStreamChunk } from "@openrouter/sdk/models/chatstreamchunk.js";
import type { EventStream } from "@openrouter/sdk/lib/event-streams.js";
import type { OpenRouterMetadata } from "@openrouter/sdk/models/openroutermetadata.js";

import { consumeOpenRouterStream } from "@vex-agent/inference/openrouter/stream.js";
import { summarizeRoutingMetadata } from "@vex-agent/inference/openrouter/routing-metadata.js";
import type { StreamChunk } from "@vex-agent/inference/types.js";

/** Minimal async-iterable stand-in for the SDK's `EventStream`. */
function streamOf(chunks: Array<Partial<ChatStreamChunk>>): EventStream<ChatStreamChunk> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk as ChatStreamChunk;
    },
  } as unknown as EventStream<ChatStreamChunk>;
}

async function collect(
  chunks: Array<Partial<ChatStreamChunk>>,
): Promise<StreamChunk[]> {
  const out: StreamChunk[] = [];
  for await (const chunk of consumeOpenRouterStream(streamOf(chunks))) out.push(chunk);
  return out;
}

function chunk(overrides: Partial<ChatStreamChunk>): Partial<ChatStreamChunk> {
  return { id: "gen-1", model: "m", object: "chat.completion.chunk", created: 1, choices: [], ...overrides };
}

describe("consumeOpenRouterStream — finish reason", () => {
  it("emits done for stop, carrying the reason and generation id", async () => {
    const out = await collect([
      chunk({ choices: [{ index: 0, delta: { content: "hi" }, finishReason: null }] as never }),
      chunk({ choices: [{ index: 0, delta: {}, finishReason: "stop" }] as never }),
    ]);

    expect(out.at(-1)).toEqual({ type: "done", finishReason: "stop", generationId: "gen-1" });
  });

  it("emits done for tool_calls", async () => {
    const out = await collect([
      chunk({ choices: [{ index: 0, delta: {}, finishReason: "tool_calls" }] as never }),
    ]);

    expect(out).toEqual([
      { type: "done", finishReason: "tool_calls", generationId: "gen-1" },
    ]);
  });

  it("NOW emits done for length — a truncated completion used to look complete", async () => {
    // The regression this whole change exists to close: previously only
    // stop/tool_calls produced a `done`, so `length` vanished entirely.
    const out = await collect([
      chunk({ choices: [{ index: 0, delta: { content: "half" }, finishReason: "length" }] as never }),
    ]);

    expect(out).toContainEqual({
      type: "done",
      finishReason: "length",
      generationId: "gen-1",
    });
  });

  it("emits done for content_filter", async () => {
    const out = await collect([
      chunk({ choices: [{ index: 0, delta: {}, finishReason: "content_filter" }] as never }),
    ]);

    expect(out.at(-1)).toMatchObject({ type: "done", finishReason: "content_filter" });
  });

  it("emits done for a reason this SDK version does not enumerate (open enum)", async () => {
    const out = await collect([
      chunk({ choices: [{ index: 0, delta: {}, finishReason: "future_reason" }] as never }),
    ]);

    expect(out.at(-1)).toMatchObject({ type: "done", finishReason: "future_reason" });
  });

  it("emits NO done while the finish reason is still null", async () => {
    const out = await collect([
      chunk({ choices: [{ index: 0, delta: { content: "a" }, finishReason: null }] as never }),
    ]);

    expect(out.some((c) => c.type === "done")).toBe(false);
  });
});

describe("consumeOpenRouterStream — generation id", () => {
  it("keeps the FIRST id seen, even if a later chunk reports a different one", async () => {
    const out = await collect([
      chunk({ id: "gen-first", choices: [{ index: 0, delta: { content: "a" }, finishReason: null }] as never }),
      chunk({ id: "gen-later", choices: [{ index: 0, delta: {}, finishReason: "stop" }] as never }),
    ]);

    expect(out.at(-1)).toMatchObject({ generationId: "gen-first" });
  });

  it("omits the id when the provider sent nothing usable", async () => {
    const out = await collect([
      chunk({ id: "", choices: [{ index: 0, delta: {}, finishReason: "stop" }] as never }),
    ]);

    expect(out.at(-1)).toEqual({ type: "done", finishReason: "stop" });
  });
});

describe("consumeOpenRouterStream — mid-stream error metadata", () => {
  it("carries errorType off error.metadata", async () => {
    const out = await collect([
      chunk({
        error: {
          code: 400,
          message: "too long",
          metadata: { errorType: "context_length_exceeded" },
        },
      } as never),
    ]);

    expect(out[0]).toEqual({
      type: "error",
      errorMessage: "too long",
      errorCode: 400,
      errorType: "context_length_exceeded",
    });
  });

  it("NEVER carries providerCode — free-form upstream text stays out", async () => {
    const out = await collect([
      chunk({
        error: {
          code: 502,
          message: "upstream said no",
          metadata: {
            errorType: "provider_unavailable",
            providerCode: "some upstream blob with a key sk-live-XYZ in it",
          },
        },
      } as never),
    ]);

    expect(out[0]).not.toHaveProperty("providerCode");
    expect(JSON.stringify(out[0])).not.toContain("sk-live-XYZ");
  });

  it("omits errorType when metadata is absent", async () => {
    const out = await collect([
      chunk({ error: { code: 500, message: "boom" } } as never),
    ]);

    expect(out[0]).toEqual({ type: "error", errorMessage: "boom", errorCode: 500 });
  });
});

describe("summarizeRoutingMetadata — bounded projection", () => {
  function metadata(overrides: Partial<OpenRouterMetadata> = {}): OpenRouterMetadata {
    return {
      attempt: 1,
      attempts: [
        { model: "m", provider: "Fireworks", status: 503 },
        { model: "m", provider: "Anthropic", status: 200 },
      ],
      endpoints: { available: [{}, {}, {}], total: 5 },
      isByok: false,
      region: null,
      requested: "m",
      strategy: "price",
      summary: "routed",
      ...overrides,
    } as unknown as OpenRouterMetadata;
  }

  it("reports the SERVING provider (the last attempt), attempt count and endpoints", () => {
    expect(summarizeRoutingMetadata(metadata())).toEqual({
      provider: "Anthropic",
      attempts: 2,
      endpointsAvailable: 3,
    });
  });

  it("projects ONLY the three bounded fields — never params/pipeline/summary", () => {
    // Those can echo request shape; logging them would drift into logging
    // request content.
    const summary = summarizeRoutingMetadata(metadata());
    expect(Object.keys(summary).sort()).toEqual([
      "attempts",
      "endpointsAvailable",
      "provider",
    ]);
  });

  it("falls back to the scalar attempt index when no attempt list is present", () => {
    const summary = summarizeRoutingMetadata(metadata({ attempts: undefined, attempt: 4 }));
    expect(summary.attempts).toBe(4);
    expect(summary.provider).toBeNull();
  });

  it("reads the SELECTED endpoint when attempts[] is absent — the live single-attempt shape", () => {
    // Measured live (DeepSeek@DeepInfra, 6/6 rounds): a normal success carries
    // NO attempts list, only the selected entry in endpoints.available. This
    // was exactly the servedProvider:null defect.
    const summary = summarizeRoutingMetadata(
      metadata({
        attempts: undefined,
        attempt: 1,
        endpoints: {
          available: [
            { model: "m", provider: "Fireworks", selected: false },
            { model: "m", provider: "DeepInfra", selected: true },
          ],
          total: 2,
        },
      } as never),
    );
    expect(summary.provider).toBe("DeepInfra");
    expect(summary.attempts).toBe(1);
  });

  it("prefers the last ATTEMPT over the selected endpoint when both exist", () => {
    // A retry's final attempt is what actually served the response; the
    // selected endpoint describes the original routing choice.
    const summary = summarizeRoutingMetadata(
      metadata({
        endpoints: {
          available: [{ model: "m", provider: "SomewhereElse", selected: true }],
          total: 1,
        },
      } as never),
    );
    expect(summary.provider).toBe("Anthropic");
  });

  it("survives a metadata block missing the endpoints section", () => {
    const summary = summarizeRoutingMetadata(
      metadata({ endpoints: undefined as never }),
    );
    expect(summary.endpointsAvailable).toBeNull();
  });
});
