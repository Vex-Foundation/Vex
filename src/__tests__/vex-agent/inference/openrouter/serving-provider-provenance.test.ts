/**
 * Endpoint-level provenance: the upstream that SERVED a request reaches the
 * response, and matches the routing projection.
 *
 * `usage_log.provider` has always stored the literal `'openrouter'`, so "which
 * request went to which provider" was unanswerable — which is why the
 * 2026-07-29 endpoint-level 429 was hard to diagnose. This pins the carry from
 * the router's metadata block through to the value the turn persists.
 *
 * The projection reads `endpoints.available[].selected`, NOT `attempts[]`:
 * live measurement (2026-07-28, 6/6 rounds) showed `attempts[]` is ABSENT on a
 * normal single-attempt success, so a reader that depended on it would return
 * null for the common path.
 */

import { describe, it, expect } from "vitest";

import type { OpenRouterMetadata } from "@openrouter/sdk/models/openroutermetadata.js";

import { summarizeRoutingMetadata } from "@vex-agent/inference/openrouter/routing-metadata.js";
import { consumeOpenRouterStream } from "@vex-agent/inference/openrouter/stream.js";
import type { StreamChunk } from "@vex-agent/inference/types.js";

/** Single-attempt success shape: `attempts[]` absent, `selected` present. */
const SINGLE_ATTEMPT_METADATA = {
  attempt: 1,
  endpoints: {
    available: [
      { model: "deepseek/deepseek-v4-flash", provider: "DeepInfra", selected: false },
      { model: "deepseek/deepseek-v4-flash", provider: "Baidu", selected: true },
    ],
    total: 21,
  },
  isByok: false,
  region: null,
  requested: "deepseek/deepseek-v4-flash",
  strategy: "price",
  summary: "",
} as unknown as OpenRouterMetadata;

async function* streamOf(chunks: ReadonlyArray<unknown>) {
  for (const chunk of chunks) yield chunk;
}

async function collect(chunks: ReadonlyArray<unknown>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = [];
  for await (const chunk of consumeOpenRouterStream(
    streamOf(chunks) as never,
  )) {
    out.push(chunk);
  }
  return out;
}

describe("summarizeRoutingMetadata — serving provider on the common path", () => {
  it("reads the SELECTED endpoint when there was no retry", () => {
    expect(summarizeRoutingMetadata(SINGLE_ATTEMPT_METADATA).provider).toBe("Baidu");
  });

  it("reports how many endpoints were eligible — 1 is how an over-narrow pin looks", () => {
    expect(summarizeRoutingMetadata(SINGLE_ATTEMPT_METADATA).endpointsAvailable).toBe(2);
  });
});

describe("consumeOpenRouterStream — provenance rides through to `done`", () => {
  it("emits the serving provider on the done chunk, matching the projection", async () => {
    const chunks = await collect([
      { id: "gen-1", openrouterMetadata: SINGLE_ATTEMPT_METADATA, choices: [{ delta: {} }] },
      { id: "gen-1", choices: [{ delta: { content: "hi" } }] },
      { id: "gen-1", choices: [{ delta: {}, finishReason: "stop" }] },
    ]);

    const done = chunks.find((c) => c.type === "done");
    expect(done?.servingProvider).toBe(
      summarizeRoutingMetadata(SINGLE_ATTEMPT_METADATA).provider,
    );
    expect(done?.generationId).toBe("gen-1");
  });

  it("omits it entirely when the response carried no routing metadata", async () => {
    const chunks = await collect([
      { id: "gen-2", choices: [{ delta: { content: "hi" } }] },
      { id: "gen-2", choices: [{ delta: {}, finishReason: "stop" }] },
    ]);
    // Absent, not "" — an empty string would look like a real answer.
    expect(chunks.find((c) => c.type === "done")?.servingProvider).toBeUndefined();
  });
});
