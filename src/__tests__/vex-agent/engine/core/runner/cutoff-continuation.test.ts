import { describe, it, expect } from "vitest";

import {
  CUTOFF_ANSWER_SUFFIX,
  CUTOFF_CONTINUATION_ENABLED,
  CUTOFF_CONTINUATION_NOTE,
  continuationMessages,
  detectCutOffAnswer,
  resolveCutoffContinuation,
  type CutoffRoundFields,
} from "@vex-agent/engine/core/runner/cutoff-continuation.js";
import type { Message } from "@vex-agent/db/repos/messages.js";

const CALL = { id: "c0", name: "web_research", arguments: {} };

function round(overrides: Partial<CutoffRoundFields>): CutoffRoundFields {
  return {
    content: null,
    toolCalls: null,
    reasoning: null,
    finishReason: "stop",
    malformedToolCallCount: 0,
    timedOut: null,
    ...overrides,
  };
}

const PARTIAL = { content: "The answer is", reasoning: "r1" };

describe("cut-off answer continuation", () => {
  it("is switched on by default and carries the contract note", () => {
    expect(CUTOFF_CONTINUATION_ENABLED).toBe(true);
    expect(CUTOFF_CONTINUATION_NOTE).toContain(
      "Your previous answer was cut off at the output limit. Continue exactly where it stopped, without repeating anything.",
    );
    expect(CUTOFF_ANSWER_SUFFIX).toBe("\n\n_(Answer cut off at the output limit.)_");
  });

  describe("detection", () => {
    it("length + text + no tool call is a cut-off answer", () => {
      expect(detectCutOffAnswer(round({ content: "half a sen", reasoning: "r", finishReason: "length" }))).toEqual({
        content: "half a sen",
        reasoning: "r",
      });
    });

    it.each<[string, Partial<CutoffRoundFields>]>([
      ["a normal stop", { content: "done", finishReason: "stop" }],
      ["no finish reason", { content: "done", finishReason: null }],
      ["blank text", { content: "  \n", finishReason: "length" }],
      ["a valid tool call", { content: "x", toolCalls: [CALL], finishReason: "length" }],
      ["a dropped tool call", { content: "x", finishReason: "length", malformedToolCallCount: 1 }],
      ["a timed-out round", { content: "x", finishReason: "length", timedOut: "idle" }],
    ])("%s is not", (_label, overrides) => {
      expect(detectCutOffAnswer(round(overrides))).toBe(null);
    });
  });

  it("the continuation messages append the fragment without touching the live tape", () => {
    const live: Message[] = [{ role: "user", content: "hi", timestamp: "2026-09-27T00:00:00.000Z" }];
    const messages = continuationMessages(live, PARTIAL);
    expect(live).toHaveLength(1);
    expect(messages).toHaveLength(2);
    expect(messages[1]).toMatchObject({ role: "assistant", content: "The answer is" });
  });

  describe("resolution", () => {
    it("a finished continuation joins exactly, with both reasoning traces", () => {
      expect(
        resolveCutoffContinuation(PARTIAL, round({ content: " 42.", reasoning: "r2", finishReason: "stop" })),
      ).toEqual({ kind: "answer", outcome: "completed", content: "The answer is 42.", reasoning: "r1\n\nr2" });
    });

    it("a continuation cut off again is joined and marked", () => {
      expect(resolveCutoffContinuation(PARTIAL, round({ content: " 4", finishReason: "length" }))).toMatchObject({
        kind: "answer",
        outcome: "still_cut_off",
        content: `The answer is 4${CUTOFF_ANSWER_SUFFIX}`,
      });
    });

    it.each<[string, Partial<CutoffRoundFields>]>([
      ["blank", { content: "" }],
      ["reasoning only", { reasoning: "thinking", finishReason: "length" }],
    ])("an unproductive (%s) continuation keeps only the fragment, marked", (_label, overrides) => {
      expect(resolveCutoffContinuation(PARTIAL, round(overrides))).toEqual({
        kind: "answer",
        outcome: "unproductive",
        content: `The answer is${CUTOFF_ANSWER_SUFFIX}`,
        reasoning: "r1",
      });
    });

    it("a timed-out continuation never persists its streamed text", () => {
      const resolution = resolveCutoffContinuation(
        PARTIAL,
        round({ content: " forty", finishReason: null, timedOut: "idle" }),
      );
      expect(resolution).toMatchObject({ kind: "answer", outcome: "timed_out" });
      expect(resolution.content).toBe(`The answer is${CUTOFF_ANSWER_SUFFIX}`);
    });

    it.each<[string, Partial<CutoffRoundFields>]>([
      ["a valid tool call", { toolCalls: [CALL], finishReason: "tool_calls" }],
      ["a dropped tool call", { malformedToolCallCount: 1, finishReason: "length" }],
    ])("a continuation with %s is a tool round: the marked fragment is saved on its own", (_label, overrides) => {
      expect(resolveCutoffContinuation(PARTIAL, round(overrides))).toEqual({
        kind: "tool_round",
        outcome: "tool_round",
        content: `The answer is${CUTOFF_ANSWER_SUFFIX}`,
        reasoning: "r1",
      });
    });
  });
});
