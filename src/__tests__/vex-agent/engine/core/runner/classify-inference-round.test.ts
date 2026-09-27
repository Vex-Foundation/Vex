import { describe, it, expect } from "vitest";

import {
  classifyInferenceRound,
  type InferenceRoundFields,
} from "@vex-agent/engine/core/runner/unproductive-rounds.js";

const CALL = { id: "c0", name: "web_research", arguments: {} };

function round(overrides: Partial<InferenceRoundFields>): InferenceRoundFields {
  return {
    content: null,
    toolCalls: null,
    finishReason: "stop",
    malformedToolCallCount: 0,
    timedOut: null,
    ...overrides,
  };
}

describe("classifyInferenceRound", () => {
  it("text or a complete tool batch is productive", () => {
    expect(classifyInferenceRound(round({ content: "hi" }))).toEqual({ kind: "productive" });
    expect(
      classifyInferenceRound(round({ toolCalls: [CALL], finishReason: "tool_calls" })),
    ).toEqual({ kind: "productive" });
  });

  it("any dropped call makes the batch incomplete, even with valid calls and text", () => {
    expect(
      classifyInferenceRound(
        round({ content: "doing it", toolCalls: [CALL], finishReason: "length", malformedToolCallCount: 1 }),
      ),
    ).toEqual({ kind: "incomplete_tool_batch", truncated: true, validToolCalls: 1, malformedToolCalls: 1 });
  });

  it.each(["tool_calls", "stop", null])("finish %s with a dropped call is malformed, not truncated", (finishReason) => {
    expect(
      classifyInferenceRound(round({ toolCalls: [CALL], finishReason, malformedToolCallCount: 2 })),
    ).toEqual({ kind: "incomplete_tool_batch", truncated: false, validToolCalls: 1, malformedToolCalls: 2 });
  });

  it("all calls dropped under length is incomplete (truncated), not reasoning_exhausted", () => {
    expect(
      classifyInferenceRound(round({ content: "", finishReason: "length", malformedToolCallCount: 1 })),
    ).toEqual({ kind: "incomplete_tool_batch", truncated: true, validToolCalls: 0, malformedToolCalls: 1 });
  });

  it("length with blank content and no calls is reasoning_exhausted", () => {
    expect(classifyInferenceRound(round({ content: "  \n", finishReason: "length" }))).toEqual({
      kind: "reasoning_exhausted",
    });
  });

  it("anything else with nothing to act on is blank", () => {
    expect(classifyInferenceRound(round({ content: "" }))).toEqual({ kind: "blank" });
    expect(classifyInferenceRound(round({ finishReason: null }))).toEqual({ kind: "blank" });
  });

  it("truncated text with no calls is still productive text", () => {
    expect(classifyInferenceRound(round({ content: "half a sen", finishReason: "length" }))).toEqual({
      kind: "productive",
    });
  });

  describe("stream_timeout", () => {
    it.each(["first_chunk", "idle", "reasoning_only", "round_deadline"] as const)(
      "a round stopped by the %s bound is a timeout, carrying the stall kind",
      (stall) => {
        expect(classifyInferenceRound(round({ finishReason: null, timedOut: stall }))).toEqual({
          kind: "stream_timeout",
          stall,
        });
      },
    );

    it("streamed text never makes a timed-out round productive", () => {
      expect(
        classifyInferenceRound(round({ content: "I will now swap", finishReason: null, timedOut: "idle" })),
      ).toEqual({ kind: "stream_timeout", stall: "idle" });
    });

    it("the timeout wins over every other class", () => {
      expect(
        classifyInferenceRound(
          round({ toolCalls: [CALL], finishReason: "length", malformedToolCallCount: 1, timedOut: "round_deadline" }),
        ),
      ).toEqual({ kind: "stream_timeout", stall: "round_deadline" });
    });

    it("a null timedOut classifies exactly as before", () => {
      expect(classifyInferenceRound(round({ content: "hi", timedOut: null }))).toEqual({ kind: "productive" });
      expect(classifyInferenceRound(round({ content: "" }))).toEqual({ kind: "blank" });
    });
  });
});
