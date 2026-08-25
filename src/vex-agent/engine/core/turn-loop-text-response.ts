/**
 * Text-only turn response handling — when `executeTurn` returns
 * content but no tool calls. Extracted from `turn-loop.ts` for
 * scaling.
 *
 * Behavior preserved bit-for-bit:
 *   - Deferred save: `saveAssistantMessage(... null toolCalls)`, now also
 *     carrying a board staged earlier in the turn (see the consume block).
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
import {
  clearPendingPresentation,
  consumePendingPresentation,
} from "./board-presentation.js";

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
  // ── Board consume: this row is the commit point ──
  // A board staged by `BoardCompose` earlier in this turn is taken here and
  // written INTO the same INSERT as the prose, so prose and board commit
  // together or not at all. Eligibility is deliberately narrow: only a
  // TEXT-ONLY assistant response (this function is reached on no tool calls)
  // whose content is not blank. A blank or whitespace-only response is not a
  // reply a board can annotate, so it leaves the board staged for the next
  // one; the loop clears it if none comes.
  //
  // Taken BEFORE the write and cleared (never restaged) when the write throws:
  // the row that would have carried it does not exist, and a later row must
  // not silently inherit an analysis written for a message the user never saw.
  const pending =
    args.content.trim() === ""
      ? null
      : consumePendingPresentation(args.context.sessionId);

  try {
    // Deferred save: text-only assistant message
    await saveAssistantMessage(args.context.sessionId, args.content, null, {
      reasoning: args.reasoning,
      ...(pending === null ? {} : { board: pending.spec }),
    });
  } catch (err) {
    if (pending !== null) {
      clearPendingPresentation(args.context.sessionId, "final_insert_failed");
    }
    throw err;
  }

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
