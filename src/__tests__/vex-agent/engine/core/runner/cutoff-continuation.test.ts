import { describe, it, expect } from "vitest";

import {
  CUTOFF_ANSWER_SUFFIX,
  CUTOFF_CONTINUATION_ENABLED,
  CUTOFF_CONTINUATION_NOTE,
  continuationMessages,
  detectCutOffAnswer,
  joinContinuation,
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

    it.each<[string, string | null]>([
      ["no finish signal", null],
      ["content_filter", "content_filter"],
      ["error", "error"],
      ["an unrecognised label", "end_turn"],
    ])("a continuation that ends with %s is joined but kept marked (ambiguous_end)", (_label, finishReason) => {
      expect(resolveCutoffContinuation(PARTIAL, round({ content: " 42.", reasoning: "r2", finishReason }))).toEqual({
        kind: "answer",
        outcome: "ambiguous_end",
        content: `The answer is 42.${CUTOFF_ANSWER_SUFFIX}`,
        reasoning: "r1\n\nr2",
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

  describe("joinContinuation", () => {
    it("joins a mid-sentence continuation as-is", () => {
      expect(joinContinuation("L1 fees can spike to dollars-to-", "hundreds during congestion."))
        .toBe("L1 fees can spike to dollars-to-hundreds during congestion.");
    });

    it("replaces a restarted section instead of duplicating it (live 2026-09-27 shape)", () => {
      const partial =
        "Verdict: ETH clearly ahead.\n\n## 2. Decentralization\n\n" +
        "ETH - Highest degree of credible neutrality among large chains.";
      const continuation =
        "## 2. Decentralization\n\nETH - Highest degree of credible neutrality among large chains. " +
        "No foundation-controlled block production.";
      expect(joinContinuation(partial, continuation)).toBe(
        "Verdict: ETH clearly ahead.\n\n## 2. Decentralization\n\n" +
          "ETH - Highest degree of credible neutrality among large chains. " +
          "No foundation-controlled block production.",
      );
    });

    it("never drops text when a repeated line is not a true restart", () => {
      const partial = "## Risks and caveats\n\nFirst point.\n\nSecond point unique to the partial";
      const continuation = "## Risks and caveats\n\nA different body.";
      const joined = joinContinuation(partial, continuation);
      expect(joined).toContain("Second point unique to the partial");
      expect(joined).toContain("A different body.");
    });

    it("drops characters the continuation repeats from the partial's end", () => {
      expect(joinContinuation("The validator set is smaller and costlier", "smaller and costlier to join."))
        .toBe("The validator set is smaller and costlier to join.");
    });

    it("starts a markdown block on a new paragraph after unfinished text", () => {
      expect(joinContinuation("chains.", "## 3. Fees\n\nETH fees vary."))
        .toBe("chains.\n\n## 3. Fees\n\nETH fees vary.");
    });

    describe("a leading ellipsis at a mid-sentence seam", () => {
      it("is dropped, restoring the space between two words (live 2026-09-27 shape)", () => {
        expect(joinContinuation("The finality model is subtle", "…consensus is reached in two rounds."))
          .toBe("The finality model is subtle consensus is reached in two rounds.");
      });

      it.each([
        ["three dots after whitespace", "  ...consensus follows."],
        ["a unicode ellipsis then a space", "… consensus follows."],
      ])("is dropped for %s", (_label, continuation) => {
        expect(joinContinuation("It is subtle", continuation)).toBe("It is subtle consensus follows.");
      });

      it("keeps the partial's own trailing space without doubling it", () => {
        expect(joinContinuation("It is subtle ", "…consensus follows.")).toBe("It is subtle consensus follows.");
      });

      it("adds no space before punctuation", () => {
        expect(joinContinuation("It is subtle", "…, and slow.")).toBe("It is subtle, and slow.");
      });

      it("is kept when the partial ended a sentence", () => {
        expect(joinContinuation("It is subtle.", " …and slow.")).toBe("It is subtle. …and slow.");
      });

      it("is kept when it is part of a restarted line", () => {
        const partial = "Intro.\n\n…and then the validator set rotates every";
        const continuation = "…and then the validator set rotates every epoch.";
        expect(joinContinuation(partial, continuation)).toBe(
          "Intro.\n\n…and then the validator set rotates every epoch.",
        );
      });
    });

    it("resolves a completed continuation through the overlap-aware join", () => {
      const partial = { content: "Intro.\n\n## Fees\n\nETH fees are", reasoning: null };
      const result = resolveCutoffContinuation(
        partial,
        round({ content: "## Fees\n\nETH fees are volatile.", finishReason: "stop" }),
      );
      expect(result).toMatchObject({ kind: "answer", content: "Intro.\n\n## Fees\n\nETH fees are volatile." });
    });
  });
});
