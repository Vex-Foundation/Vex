/**
 * Emission of the tool-call-loop correction cue into a live turn.
 *
 * Split from the batch orchestrator for the same reason every other policy in
 * this folder is: the orchestrator owns the dispatch ordering, and this owns
 * one durable write plus one live-tape mutation. The TEXT is a versioned
 * prompt artifact and lives in `prompts/tool-call-loop-correction.ts`; this
 * module only decides where it lands and when.
 *
 * ORDERING is the contract. The cue is written AFTER `persistBatchTranscript`,
 * so the tape reads: assistant message with the full emitted batch, then every
 * tool result including the drained remainder, then the correction. A cue
 * placed before the results would have the model reading an instruction about
 * calls it has not yet seen the outcome of, and would break the
 * tool_call/tool_result adjacency the provider expects.
 *
 * Both halves of the write matter and neither is optional:
 *   - the durable row, so the cue survives a reload and is reconstructable
 *     from history (rule 09's model-visible-iff-logged);
 *   - the `liveMessages` push, so the CURRENT turn's next inference actually
 *     carries it. Persisting only would leave the very round the correction
 *     exists for reading a tape without it.
 *
 * `visibility: "internal"` mirrors the operator cue: this is engine-to-model
 * text, not an announcement to the user. The user's account of the same event
 * is the run's own stop payload and, at strike two, the honest reply.
 */

import type { Message } from "@vex-agent/db/repos/messages.js";
import { appendEngineMessage } from "@vex-agent/engine/events/index.js";
import { buildToolCallLoopCorrectionCue } from "../../prompts/tool-call-loop-correction.js";
import type { ToolCallLoopFacts } from "../runner/tool-call-loop-detector.js";

export const TOOL_CALL_LOOP_CORRECTION_MESSAGE_TYPE = "tool_call_loop_correction";

export async function emitToolCallLoopCorrection(input: {
  readonly sessionId: string;
  readonly missionRunId: string | null;
  readonly facts: ToolCallLoopFacts;
  /** MUTATED: pushed with the cue so THIS turn's next round reads it. */
  readonly liveMessages: Message[];
}): Promise<string> {
  const cue = buildToolCallLoopCorrectionCue({
    toolName: input.facts.toolName,
    cycleLength: input.facts.cycleLength,
    repeatCount: input.facts.repeatCount,
  });

  const metadata = {
    source: "engine" as const,
    messageType: TOOL_CALL_LOOP_CORRECTION_MESSAGE_TYPE,
    visibility: "internal" as const,
    payload: {
      // Structured facts, never raw arguments - see `ToolCallLoopFacts`.
      toolName: input.facts.toolName,
      cycleLength: input.facts.cycleLength,
      repeatCount: input.facts.repeatCount,
      toolCallIds: input.facts.toolCallIds,
      strike: input.facts.strike,
      missionRunId: input.missionRunId,
    },
  };

  await appendEngineMessage(input.sessionId, cue, metadata);

  input.liveMessages.push({
    role: "system",
    content: cue,
    timestamp: new Date().toISOString(),
    metadata,
  });

  return cue;
}
