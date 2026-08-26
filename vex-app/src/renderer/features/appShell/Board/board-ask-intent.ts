/**
 * ASK VEX INTENT CHANNEL - the one place a board surface parks a question for
 * the RESIDENT composer, and the one place the composer takes it from.
 *
 * WHY A CHANNEL AND NOT A SUBMIT. The board modal must never call the chat
 * API (A4). A second submit path would be a second answer to "is a turn in
 * flight", "is free text gated", "did steering refuse" - the exact questions
 * `composer-submit.ts` already owns, with a mutex, a mission gate, a steering
 * fallback, a queue and a retry contract behind them. So the panel produces an
 * ENVELOPE and the composer that owns those rules consumes it.
 *
 * SESSION-KEYED. An intent names the session it was composed in. The composer
 * dispatches it only into that session and DROPS it otherwise: a question
 * about a board in session A must never land in session B's transcript
 * because the reader switched while the panel was open.
 *
 * CONSUMED ONCE. {@link BoardAskIntentState.consumeBoardAskIntent} is the only
 * read that dispatches, it clears the slot in the same synchronous step, and
 * it is keyed by `intentId`. StrictMode's double-invoked effect therefore
 * finds nothing on its second pass, and the same question cannot be sent
 * twice. This mirrors `uiStore`'s `createSessionInitialTurn` hand-off, which
 * solves the identical problem for the welcome-to-session first turn.
 *
 * Book-local Zustand in the shape of `book/inspect/inspect-store.ts`: UI-only,
 * NEVER persisted. An unsent question is not a preference, and a question that
 * survived a restart would be a question about figures that no longer exist.
 */

import { create } from "zustand";
import type { BoardAskIntent } from "./board-surface-contracts.js";

interface BoardAskIntentState {
  /** The parked question, or null when nothing is waiting. */
  readonly intent: BoardAskIntent | null;
  /**
   * Park a question for the resident composer.
   *
   * Replaces whatever was parked: a reader who pressed Send twice with two
   * different questions gets the second one, and the first was never
   * dispatched (it is still in the panel's field until the panel says
   * otherwise).
   */
  readonly publishBoardAskIntent: (intent: BoardAskIntent) => void;
  /**
   * Take the parked question if it is THIS one and belongs to THIS session.
   *
   * Returns null - and leaves the slot alone - when the id does not match
   * (already consumed) or the session does not (a switch happened). Clearing
   * happens in the same step as the read, so there is no window in which two
   * callers can both see it.
   */
  readonly consumeBoardAskIntent: (
    intentId: string,
    sessionId: string,
  ) => BoardAskIntent | null;
  /** Drop the parked question without dispatching it. */
  readonly clearBoardAskIntent: () => void;
}

export const useBoardAskIntentStore = create<BoardAskIntentState>((set, get) => ({
  intent: null,
  publishBoardAskIntent: (intent) => {
    set({ intent });
  },
  consumeBoardAskIntent: (intentId, sessionId) => {
    const current = get().intent;
    if (
      current === null ||
      current.intentId !== intentId ||
      current.sessionId !== sessionId
    ) {
      return null;
    }
    set({ intent: null });
    return current;
  },
  clearBoardAskIntent: () => {
    set({ intent: null });
  },
}));

/**
 * A fresh consume-once key.
 *
 * `crypto.randomUUID` where the runtime has it (Electron's renderer and
 * jsdom both do); the counter is the last resort, and it only has to be
 * unique within one renderer's lifetime because nothing persists an intent.
 */
let intentCounter = 0;
export function nextBoardAskIntentId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (typeof uuid === "string") return uuid;
  intentCounter += 1;
  return `board-ask-${String(intentCounter)}`;
}
