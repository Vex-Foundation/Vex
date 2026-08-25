/**
 * The pending board presentation: one staged board per session, owned by the
 * turn loop and consumed by the assistant row that carries the final prose.
 *
 * WHY A RUNTIME OWNER AND NOT A DB ROW. A staged board is not durable state
 * and must never become one. It exists only between the `BoardCompose` call
 * that produced it and the SAME turn loop's final assistant INSERT, which is
 * where it becomes durable, in the same row as the prose it annotates. One
 * INSERT is the commit point; there is no window in which a board is persisted
 * without the message it belongs to, and none in which a message claims a
 * board that was never staged.
 *
 * LIFECYCLE, AND WHY THE SCOPE EXISTS. `runTurnLoop` opens a scope at entry
 * and closes it at every exit. Staging is possible ONLY inside an open scope,
 * so a `BoardCompose` reached from anywhere that is not a live turn (an
 * approval resume, a direct handler call in a test) fails closed instead of
 * leaving a board pending for whichever turn runs next. Closing the scope
 * clears whatever is pending, which is the single mechanism behind every
 * clearing row of the state table: stop, cancel, iteration exhaustion, a
 * failed hydration, a failed final INSERT, and a throw all leave the loop, and
 * leaving the loop closes the scope.
 *
 * STRUCTURAL UNREACHABILITY. While a board is pending, the batch gate refuses
 * EVERY tool call before dispatch (see
 * `./turn-loop-tool-batch/presentation-gate.ts`). Approval parking and
 * user-form parking are consequences of a dispatched tool, so neither can be
 * reached while a board is pending. That is a property of the gate, not a
 * rule this module has to restate.
 *
 * NOT A CACHE AND NOT A QUEUE. At most one entry per session, replaced by
 * nothing: a second compose is refused rather than overwriting the first, so
 * the board the model was told is staged is the board that lands.
 */

import type { BoardSpecV1 } from "../../../lib/board/index.js";
import logger from "@utils/logger.js";

/** A board staged by `BoardCompose` and waiting for the turn's final prose. */
export interface PendingPresentation {
  readonly spec: BoardSpecV1;
  /** When the compose staged it, for the log line that records a clear. */
  readonly stagedAtMs: number;
}

/** Why a pending presentation was discarded. Log-only; never model-visible. */
export type PresentationClearReason =
  | "scope_closed"
  | "scope_reopened"
  | "final_insert_failed";

/**
 * Open scopes, keyed by session. Presence of the key means "a turn loop is
 * running for this session and staging is allowed"; the value is the staged
 * board or `null` when nothing is staged yet.
 */
const scopes = new Map<string, PendingPresentation | null>();

/** Outcome of a staging attempt. Every non-`staged` value is a refusal. */
export type StageOutcome = "staged" | "no_open_scope" | "already_pending";

/**
 * Open the session's presentation scope. Called once at turn-loop entry.
 *
 * A scope that is already open is REPLACED and its pending board discarded: an
 * earlier loop that threw past its own close is the only way to reach this,
 * and carrying its board into a different loop would attach an analysis to
 * prose that was never written for it.
 */
export function beginPresentationScope(sessionId: string): void {
  const stale = scopes.get(sessionId);
  if (stale !== undefined && stale !== null) {
    logger.warn("board.presentation.cleared", {
      sessionId,
      reason: "scope_reopened" satisfies PresentationClearReason,
      stagedAtMs: stale.stagedAtMs,
    });
  }
  scopes.set(sessionId, null);
}

/** Close the scope and discard anything still pending. Idempotent. */
export function endPresentationScope(sessionId: string): void {
  const pending = scopes.get(sessionId);
  if (pending !== undefined && pending !== null) {
    logger.info("board.presentation.cleared", {
      sessionId,
      reason: "scope_closed" satisfies PresentationClearReason,
      stagedAtMs: pending.stagedAtMs,
    });
  }
  scopes.delete(sessionId);
}

/**
 * Discard the pending board while keeping the scope open.
 *
 * The one caller is the final-INSERT failure path: the row that would have
 * carried the board did not commit, so the board is gone and the model must
 * not be led to believe otherwise by a later prose row picking it up.
 */
export function clearPendingPresentation(
  sessionId: string,
  reason: PresentationClearReason,
): void {
  if (!scopes.has(sessionId)) return;
  const pending = scopes.get(sessionId) ?? null;
  if (pending !== null) {
    logger.warn("board.presentation.cleared", {
      sessionId,
      reason,
      stagedAtMs: pending.stagedAtMs,
    });
  }
  scopes.set(sessionId, null);
}

/** Stage a board for this session's open scope. Never overwrites. */
export function stagePresentation(
  sessionId: string,
  spec: BoardSpecV1,
  nowMs: number,
): StageOutcome {
  if (!scopes.has(sessionId)) return "no_open_scope";
  if ((scopes.get(sessionId) ?? null) !== null) return "already_pending";
  scopes.set(sessionId, { spec, stagedAtMs: nowMs });
  return "staged";
}

/** Whether a board is waiting for this session's final prose. */
export function hasPendingPresentation(sessionId: string): boolean {
  return (scopes.get(sessionId) ?? null) !== null;
}

/**
 * Take the pending board, leaving the scope open and empty.
 *
 * The caller MUST persist it in the same assistant INSERT it is consuming for,
 * and MUST call `clearPendingPresentation` if that INSERT throws. Reading
 * without taking would let two rows claim the same board.
 */
export function consumePendingPresentation(
  sessionId: string,
): PendingPresentation | null {
  const pending = scopes.get(sessionId) ?? null;
  if (pending === null) return null;
  scopes.set(sessionId, null);
  return pending;
}
