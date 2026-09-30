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
 *     The marker is written only when the tape does not already end in
 *     one followed by nothing but text-only assistant rows (see
 *     `tailAlreadyCarriesContinueCue`), so consecutive text replies leave
 *     ONE marker instead of one per reply. The loop continues either way.
 *   - Mission RUN honest idle (Kairos B-1): when this slice already called
 *     `LoopDefer`, no operator instruction arrived, and a wake for THIS run
 *     is pending, text ends the slice with NO continue cue. The caller parks
 *     the run on that wake (`deferred_idle`), exactly as a successful
 *     `LoopDefer` would have. A `LoopDefer` that scheduled nothing (refused
 *     arguments, a watch condition already true) leaves no pending wake, so
 *     real work continues with the cue as before.
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
import { isLeaseLost } from "../runtime/lease-guard.js";
import * as loopWakeRepo from "@vex-agent/db/repos/loop-wake.js";
import logger from "@utils/logger.js";
import {
  clearPendingPresentation,
  consumePendingPresentation,
} from "./board-presentation.js";

/** The persisted system cue that keeps an active mission run going after text. */
export const MISSION_CONTINUE_CUE =
  "[Engine: continue - no stop condition met. Proceed with next action.]";

/**
 * The cue after a mission report that carried a staged board. The board rule
 * refuses every tool call until that report is written, including
 * `MissionStop`, so a finished mission reaches its stop only on the round after
 * the report. "No stop condition met" would be false there and invited another
 * round of prose; this cue names the next action instead.
 */
export const MISSION_BOARD_DELIVERED_CUE =
  "[Engine: report and board delivered. If a stop condition is met, call MissionStop now; otherwise proceed with the next action.]";

export type TextResponseOutcome =
  | { kind: "mission_run_continue" }
  | { kind: "break_on_text" }
  /**
   * Mission run, honest idle: the slice already deferred and the run's wake is
   * pending. No continue cue was written; the caller parks the run on it.
   */
  | { kind: "deferred_idle"; wake: { readonly dueAt: string; readonly reason: string | null } }
  /** The runner's lease was lost: write no continue marker, end on `lease_lost`. */
  | { kind: "lease_lost" };

export async function handleTextResponse(args: {
  readonly context: EngineContext;
  /** MUTATED: pushed with assistant message and (in mission-run) the [Engine: continue] system marker. */
  readonly liveMessages: Message[];
  readonly content: string;
  /** Provider reasoning trace for this turn; persisted on the assistant row. */
  readonly reasoning: string | null;
  readonly mergeOperatorInstructions: () => Promise<void>;
  /**
   * True when a `LoopDefer` call was part of a tool batch earlier in THIS turn
   * loop (this slice). Scopes the honest-idle check: a defer from an earlier
   * slice says nothing about now. Absent = false.
   */
  readonly loopDeferCalledThisSlice?: boolean;
}): Promise<TextResponseOutcome> {
  const boardAttached = await persistTextAnswer({ ...args, attachBoard: true });

  // A fenced save refused after a takeover (or a loss seen by the heartbeat)
  // ends the turn here: the continue marker below is a write too, and it
  // belongs to whichever runner owns the session now.
  if (isLeaseLost(args.context.leaseGuard)) return { kind: "lease_lost" };

  // Active mission RUN: text does NOT end the loop - inject a continue
  // marker so the next iteration has the protocol cue. Mission SETUP
  // (`sessionKind=mission` but no missionRunId) ends on text like agent.
  if (args.context.missionRunId) {
    const tapeBeforeMerge = args.liveMessages.length;
    await args.mergeOperatorInstructions();
    const operatorSpoke = args.liveMessages.length > tapeBeforeMerge;

    // Honest idle (B-1). An operator instruction that just arrived is new work,
    // so it always wins over parking.
    if (args.loopDeferCalledThisSlice === true && !operatorSpoke) {
      const wake = await pendingWakeForRun(args.context.sessionId, args.context.missionRunId);
      if (wake !== null) return { kind: "deferred_idle", wake };
    }

    // One cue per run of consecutive text replies: every append would
    // otherwise be re-sent on every later round. The tape is only ever
    // appended to (never rewritten), so the cached prompt prefix stays
    // stable and the persisted rows match the live tape.
    if (!tailAlreadyCarriesContinueCue(args.liveMessages)) {
      const cue = boardAttached ? MISSION_BOARD_DELIVERED_CUE : MISSION_CONTINUE_CUE;
      await appendEngineMessage(
        args.context.sessionId,
        cue,
        { source: "engine", messageType: "continue", visibility: "internal" },
      );

      args.liveMessages.push({
        role: "system",
        content: cue,
        timestamp: new Date().toISOString(),
      });
    }

    return { kind: "mission_run_continue" };
  }

  // Chat and mission setup: text ends the loop cleanly.
  return { kind: "break_on_text" };
}

/**
 * The pending wake that belongs to this run, or null. Read failures return
 * null: the run then keeps its continue cue, which is the behaviour before
 * honest idle existed, rather than parking on a wake nobody verified.
 */
async function pendingWakeForRun(
  sessionId: string,
  missionRunId: string,
): Promise<{ dueAt: string; reason: string | null } | null> {
  try {
    const wake = await loopWakeRepo.getPendingForSession(sessionId);
    if (wake === null || wake.missionRunId !== missionRunId) return null;
    return { dueAt: wake.dueAt, reason: wake.reason };
  } catch (err) {
    logger.warn("engine.mission.idle_defer_wake_read_failed", {
      sessionId,
      missionRunId,
      error: err instanceof Error ? err.name : "unknown",
    });
    return null;
  }
}

/**
 * True when the most recent row that is not a text-only assistant reply is
 * already the continue cue: the model has been told to continue and has only
 * answered in prose since, so another cue would add nothing but tokens.
 *
 * Anything else in between (a tool call or result, an operator instruction,
 * an approval or correction cue, a user message) means the cue is no longer
 * the latest thing the model was told, and a fresh one is written.
 */
export function tailAlreadyCarriesContinueCue(messages: readonly Message[]): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const row = messages[i];
    if (row === undefined) return false;
    if (row.role === "assistant" && (row.toolCalls === undefined || row.toolCalls.length === 0)) {
      continue;
    }
    return row.role === "system"
      && (row.content === MISSION_CONTINUE_CUE || row.content === MISSION_BOARD_DELIVERED_CUE);
  }
  return false;
}

/**
 * Save one text-only assistant row and push it onto the live tape - the
 * persistence half of `handleTextResponse`, without its loop-control half.
 *
 * Also used by the cut-off continuation (`runner/cutoff-continuation.ts`) for
 * the rows it saves outside the normal text path: a held-back answer flushed
 * when the turn ends before its continuation (`attachBoard: true` - it is the
 * turn's final prose), and a fragment saved ahead of a continuation that
 * called tools (`attachBoard: false` - the prose that ends the turn comes
 * later and should carry the board).
 *
 * Returns whether this row carried a staged board.
 */
export async function persistTextAnswer(args: {
  readonly context: EngineContext;
  /** MUTATED: pushed with the assistant message. */
  readonly liveMessages: Message[];
  readonly content: string;
  readonly reasoning: string | null;
  readonly attachBoard: boolean;
}): Promise<boolean> {
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
    !args.attachBoard || args.content.trim() === ""
      ? null
      : consumePendingPresentation(args.context.sessionId);

  try {
    // Deferred save: text-only assistant message
    await saveAssistantMessage(args.context.sessionId, args.content, null, {
      reasoning: args.reasoning,
      ...(pending === null ? {} : { board: pending.spec }),
      ...(args.context.leaseGuard === undefined
        ? {}
        : { leaseGuard: args.context.leaseGuard }),
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
  return pending !== null;
}
