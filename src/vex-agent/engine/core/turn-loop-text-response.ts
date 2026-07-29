/**
 * Text-only turn response handling — when `executeTurn` returns
 * content but no tool calls. Extracted from `turn-loop.ts` for
 * scaling.
 *
 * Behavior preserved bit-for-bit:
 *   - Deferred save: `saveAssistantMessage(... null toolCalls)`.
 *   - Push assistant message into the mutable `liveMessages` array.
 *   - Mission RUN: text does NOT end the loop. Merge pending operator
 *     instructions, append `[Engine: continue ...]` marker message
 *     via `appendEngineMessage`, push the marker into `liveMessages`,
 *     signal `mission_run_continue` so the caller continues the loop.
 *   - Mission SETUP (`sessionKind=mission` but no `missionRunId`) and
 *     chat: text ends the loop cleanly. Signal `break_on_text` so
 *     the caller sets `stoppedOnText = true` and breaks.
 *
 * `mergeOperatorInstructions` stays as a caller-provided callback
 * because it closes over the loop's `lastSeenOperatorMessageId`
 * counter and the `liveMessages` array — externalising the closure
 * would force the helper to re-implement that bookkeeping.
 */

import type { EngineContext } from "../types.js";
import type { Message } from "@vex-agent/db/repos/messages.js";
import { saveAssistantMessage } from "./turn.js";
import { appendEngineMessage } from "@vex-agent/engine/events/index.js";

export type TextResponseOutcome =
  | { kind: "mission_run_continue" }
  | { kind: "break_on_text" };

export async function handleTextResponse(args: {
  readonly context: EngineContext;
  /** MUTATED: pushed with assistant message and (in mission-run) the [Engine: continue] system marker. */
  readonly liveMessages: Message[];
  readonly content: string;
  /** Provider reasoning trace for this turn; persisted on the assistant row. */
  readonly reasoning: string | null;
  readonly mergeOperatorInstructions: () => Promise<void>;
}): Promise<TextResponseOutcome> {
  // Deferred save: text-only assistant message
  await saveAssistantMessage(args.context.sessionId, args.content, null, {
    reasoning: args.reasoning,
  });

  args.liveMessages.push({
    role: "assistant",
    content: args.content,
    timestamp: new Date().toISOString(),
  });

  // Active mission RUN: text does NOT end the loop — inject a continue
  // marker so the next iteration has the protocol cue. Mission SETUP
  // (`sessionKind=mission` but no missionRunId) ends on text like agent.
  if (args.context.missionRunId) {
    await args.mergeOperatorInstructions();

    await appendEngineMessage(
      args.context.sessionId,
      "[Engine: continue — no stop condition met. Proceed with next action.]",
      { source: "engine", messageType: "continue", visibility: "internal" },
    );

    args.liveMessages.push({
      role: "system",
      content: "[Engine: continue — no stop condition met. Proceed with next action.]",
      timestamp: new Date().toISOString(),
    });

    return { kind: "mission_run_continue" };
  }

  // Chat and mission setup: text ends the loop cleanly.
  return { kind: "break_on_text" };
}
