/**
 * The tool-call repetition CORRECTION cue, as a versioned prompt artifact
 * (rule 09).
 *
 * ## Why the bytes are pinned HERE and not in `__promptsnaps__`
 *
 * The promptsnaps freeze the assembled STATIC PREFIX of each mode. This cue is
 * not a prompt-stack layer and never enters that prefix: it is a TRANSCRIPT
 * cue, written into the tape at the moment a repetition is detected and read
 * by the model on its next round - the same class of artifact as
 * `OPERATOR_INTERRUPT_CUE`, which is likewise absent from the snapshots.
 * Regenerating the promptsnaps for this change produces an empty diff, which
 * would be evidence of nothing.
 *
 * So this test IS the reviewed diff surface for it: the cue's exact bytes, in
 * both of its shapes, so a change to text the model reads is a change to this
 * file and shows up as a contract diff in review.
 *
 * The semantic assertions below are the eval half. They are deterministic
 * because the artifact is: it is a pure function of three structured facts,
 * with no model in the loop.
 */

import { describe, expect, it } from "vitest";

import { buildToolCallLoopCorrectionCue } from "@vex-agent/engine/prompts/tool-call-loop-correction.js";

const SINGLE = buildToolCallLoopCorrectionCue({
  toolName: "swap_quote",
  cycleLength: 1,
  repeatCount: 5,
});

const CYCLE = buildToolCallLoopCorrectionCue({
  toolName: "swap_quote",
  cycleLength: 2,
  repeatCount: 5,
});

describe("the cue's exact bytes", () => {
  it("k = 1: the same call repeating", () => {
    expect(SINGLE).toBe(
      "[Engine: tool_call_loop_correction - you have now called swap_quote 5 times in a row"
      + " with identical arguments and received an identical result every time."
      + " Repeating it again will not change the answer. Do not re-issue that call."
      + " Do exactly one of these instead: try a genuinely different approach to the same goal,"
      + " tell the user what is blocking you and ask for the missing decision or input,"
      + " or stop and summarise what you established so far."
      + " The remaining tool calls from your last message were not executed."
      + " If this repetition continues, the turn will be ended for you.]",
    );
  });

  it("k > 1: a cycle of calls repeating", () => {
    expect(CYCLE).toBe(
      "[Engine: tool_call_loop_correction - your last 10 tool calls are the same cycle of 2 calls"
      + " repeated 5 times, starting with swap_quote, each returning an identical result."
      + " Repeating it again will not change the answer. Do not re-issue that call."
      + " Do exactly one of these instead: try a genuinely different approach to the same goal,"
      + " tell the user what is blocking you and ask for the missing decision or input,"
      + " or stop and summarise what you established so far."
      + " The remaining tool calls from your last message were not executed."
      + " If this repetition continues, the turn will be ended for you.]",
    );
  });
});

describe("what the cue must do", () => {
  it("is an engine marker, so the model cannot mistake it for a user instruction", () => {
    for (const cue of [SINGLE, CYCLE]) {
      expect(cue.startsWith("[Engine: ")).toBe(true);
      expect(cue.endsWith("]")).toBe(true);
    }
  });

  it("describes what the model ACTUALLY did - the two shapes are not interchangeable", () => {
    // A cue that calls an A-B-A-B ping-pong "the same tool call" is factually
    // wrong about the transcript the model is reading, and a model that can
    // see it is wrong has a reason to dismiss it.
    expect(SINGLE).toContain("5 times in a row with identical arguments");
    expect(CYCLE).toContain("the same cycle of 2 calls");
    expect(CYCLE).not.toContain("in a row with identical arguments");
  });

  it("names three concrete exits, not a yes/no question", () => {
    expect(SINGLE).toContain("a genuinely different approach");
    expect(SINGLE).toContain("ask for the missing decision or input");
    expect(SINGLE).toContain("stop and summarise");
  });

  it("states the consequence, so the next round has a reason to be different", () => {
    expect(SINGLE).toContain("the turn will be ended for you");
  });

  it("tells the model its remaining calls did not run - the drain is not silent", () => {
    expect(SINGLE).toContain("were not executed");
  });

  it("interpolates ONLY the tool name and the counts, never arguments or results", () => {
    const cue = buildToolCallLoopCorrectionCue({
      toolName: "wallet_send",
      cycleLength: 1,
      repeatCount: 5,
    });
    // Nothing but `{toolName}` and the numbers may vary between two cues built
    // from calls that differ only in their (sensitive) arguments.
    expect(cue).toBe(SINGLE.replace("swap_quote", "wallet_send"));
  });
});
