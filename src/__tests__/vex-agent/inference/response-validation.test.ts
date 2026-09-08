import { describe, expect, it } from "vitest";

import { hasActionableInferenceResponse } from "@vex-agent/inference/response-validation.js";
import type { InferenceResponse } from "@vex-agent/inference/types.js";

const BASE: InferenceResponse = {
  content: "",
  toolCalls: null,
  usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
  reasoning: null,
  finishReason: "stop",
  generationId: "gen-1",
  servingProvider: "provider-a",
};

describe("actionable inference response predicate", () => {
  it("accepts final text and tool calls", () => {
    expect(hasActionableInferenceResponse({ ...BASE, content: "done" })).toBe(true);
    expect(
      hasActionableInferenceResponse({
        ...BASE,
        content: null,
        toolCalls: [{ id: "call-1", name: "status", arguments: {} }],
      }),
    ).toBe(true);
  });

  it("rejects empty, whitespace-only, and reasoning-only completions", () => {
    expect(hasActionableInferenceResponse(BASE)).toBe(false);
    expect(hasActionableInferenceResponse({ ...BASE, content: " \n\t" })).toBe(false);
    expect(
      hasActionableInferenceResponse({ ...BASE, reasoning: "private reasoning" }),
    ).toBe(false);
  });

  it("reads the turn loop's round shape, not only a provider response", () => {
    // The engine's blank-round detector calls this predicate with the round it
    // is about to classify. One rule, two callers: if the shapes ever diverge
    // this stops compiling instead of drifting silently.
    expect(hasActionableInferenceResponse({ content: null, toolCalls: [] })).toBe(false);
    expect(hasActionableInferenceResponse({ content: "answer", toolCalls: null })).toBe(true);
  });
});
