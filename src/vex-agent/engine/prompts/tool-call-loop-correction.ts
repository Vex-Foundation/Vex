/**
 * The tool-call repetition CORRECTION cue - a model-visible prompt artifact.
 *
 * NOT a system-prompt layer. It is never assembled into the prompt stack and
 * never appears in `__promptsnaps__`, which snapshot the static prefix only.
 * It is a TRANSCRIPT cue, the same class of artifact as
 * `core/operator-instructions.ts`'s `OPERATOR_INTERRUPT_CUE`: written into the
 * tape at a specific moment, read by the model on its next round, gone from
 * every later turn's context once the tape moves on. It lives here because
 * that is where the repository keeps text the model reads, and because a
 * versioned prompt artifact needs one home and one reviewed diff surface
 * (rule 09). Its bytes are pinned by
 * `src/__tests__/vex-agent/engine/core/runner/tool-call-loop-correction-cue.test.ts`.
 *
 * ## What it has to accomplish, and what it must not
 *
 * It is emitted on the FIRST strike of the loop detector, after the remainder
 * of the emitted batch has been drained, so it is the last thing the model
 * reads before it chooses its next call. One shot to change the trajectory.
 *
 * So it states the observation as fact rather than asking a question the model
 * can answer "yes, I am making progress" to, it names the three concrete exits
 * (different approach, ask the user, stop), and it says plainly what happens
 * if the repetition continues - a model that knows the next repeat ends the
 * turn has a reason to spend its round differently.
 *
 * It deliberately does NOT quote the arguments or the repeated result back.
 * The arguments are the sensitive part by inference (a destination, an amount,
 * a provider error carrying a fragment of something), they are already in the
 * transcript the model is reading, and re-printing them would invite the model
 * to treat them as the thing to reproduce. `{toolName}` and the counts are the
 * whole interpolation surface.
 *
 * It is written as an `[Engine: ...]` marker for the same reason the operator
 * cue is: the model must be able to tell an engine statement about its own
 * behaviour from a user's instruction, and must not mistake it for a tool
 * result it should answer.
 */

/**
 * Build the correction cue for one detected repetition.
 *
 * `cycleLength` is the detector's k: 1 means the same call over and over, more
 * than 1 means a cycle of that many calls repeating in order. The sentence
 * changes shape between those two cases because "the same tool call" is simply
 * false for an A-B-A-B ping-pong, and a cue that misdescribes what the model
 * did is a cue it can dismiss.
 */
export function buildToolCallLoopCorrectionCue(input: {
  readonly toolName: string;
  readonly cycleLength: number;
  readonly repeatCount: number;
}): string {
  const observation = input.cycleLength === 1
    ? `you have now called ${input.toolName} ${input.repeatCount} times in a row with identical arguments and received an identical result every time`
    : `your last ${input.cycleLength * input.repeatCount} tool calls are the same cycle of ${input.cycleLength} calls repeated ${input.repeatCount} times, starting with ${input.toolName}, each returning an identical result`;

  return [
    `[Engine: tool_call_loop_correction - ${observation}.`,
    "Repeating it again will not change the answer. Do not re-issue that call.",
    "Do exactly one of these instead: try a genuinely different approach to the same goal,"
    + " tell the user what is blocking you and ask for the missing decision or input,"
    + " or stop and summarise what you established so far.",
    "The remaining tool calls from your last message were not executed."
    + " If this repetition continues, the turn will be ended for you.]",
  ].join(" ");
}
