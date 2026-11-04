/**
 * THE LIVE TURN'S MEASURED TIME, kept past the turn (docs/design/H3-DESKTOP.md
 * section 4.1 item 14 and Appendix A.7: "Thought for N s" only after a live
 * turn, since persisted turns store no duration).
 *
 * A persisted message carries no reasoning duration (`SessionMessageDto` has
 * `reasoning`, the trace, and nothing that says how long it took), so a turn
 * reopened from history can only say how many steps it took. The one time
 * the renderer really has is the live turn's own clock: the timer the reader
 * watched on the live row, from the send to the moment Vex finished her
 * answer. `TurnIsland` reads that clock when the turn settles and hands it up;
 * `SessionTranscript` files it here under the person's message that opened
 * the turn, and the turn's thinking row reads it back as "Thought for 2.8 s".
 *
 * WHAT MAKES IT HONEST:
 *  - it is a measurement, never a derivation: the elapsed time of the live
 *    turn clock (`useTurnPreview` pins its start to the send), read once, at
 *    the frame the turn settled;
 *  - a turn that waited on the person (an approval card) records nothing: its
 *    clock kept running while the decision was the reader's, so it would
 *    count their time as Vex's thinking. Such a turn says its steps only;
 *  - it lives in renderer memory only, like the stream preview it was read
 *    from: never persisted, never sent, gone on reload. After a reload the
 *    row shows only what is stored, which is exactly the contract.
 *
 * Bounded: each session keeps the newest `TURN_CLOCK_LIMIT` turns, so a long
 * session cannot grow this without bound.
 */

import { create } from "zustand";

/** How many measured turns one session keeps; the oldest goes first. */
export const TURN_CLOCK_LIMIT = 32;

/** Measured thinking time in ms, by the id of the person's message that opened the turn. */
export type TurnClockBySession = Readonly<Record<string, ReadonlyMap<number, number>>>;

interface TurnClockState {
  readonly bySession: TurnClockBySession;
  /** File one settled live turn's measured time under its opening message. */
  readonly record: (sessionId: string, anchorId: number, thoughtMs: number) => void;
}

const EMPTY: ReadonlyMap<number, number> = new Map();

export const useTurnClockStore = create<TurnClockState>((set) => ({
  bySession: {},
  record: (sessionId, anchorId, thoughtMs) => {
    if (!Number.isFinite(thoughtMs) || thoughtMs < 0) return;
    set((state) => {
      const current = state.bySession[sessionId] ?? EMPTY;
      if (current.get(anchorId) === thoughtMs) return state;
      const next = new Map(current);
      next.delete(anchorId);
      next.set(anchorId, thoughtMs);
      while (next.size > TURN_CLOCK_LIMIT) {
        const oldest = next.keys().next().value;
        if (oldest === undefined) break;
        next.delete(oldest);
      }
      return { bySession: { ...state.bySession, [sessionId]: next } };
    });
  },
}));

/** The measured turns of one session (empty when none was watched live). */
export function useTurnClock(sessionId: string): ReadonlyMap<number, number> {
  return useTurnClockStore((s) => s.bySession[sessionId] ?? EMPTY);
}

/**
 * How far the opening message's own timestamp may sit from the turn clock's
 * start and still be the message that started it. The clock starts at the
 * send in the renderer and the row is stamped when the engine writes it, a
 * moment later on the same machine; a message more than this far from the
 * start was not this turn's ask (a wake or mission turn under an old message).
 */
export const ANCHOR_WINDOW_MS = 15_000;

/** The facts about a transcript row the anchor rule reads. */
export interface AnchorCandidate {
  readonly id: number;
  readonly variant: string;
  readonly createdAt: string;
  /** An operator instruction sent into a running turn (`TranscriptRowModel`). */
  readonly steering?: boolean;
}

/**
 * The person's message a just-settled live turn answered, or `null` when it
 * cannot be proven, in which case nothing is recorded (fail closed):
 *
 *  - the NEWEST row from the person must be the turn's own ask, written
 *    within `ANCHOR_WINDOW_MS` of the turn clock's start. A turn that began
 *    under an older message (a wake, a mission round) has no ask of its own
 *    in view, so its time is never filed under someone else's question;
 *  - that row must not be a steering message. A steer sent into the running
 *    turn splits it on screen, and the clock measured the whole turn, part of
 *    which sits above the steer; filing it under either half would claim the
 *    half took the whole time.
 */
export function settledTurnAnchor(
  rows: readonly AnchorCandidate[],
  turnStartedAtMs: number,
): number | null {
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i];
    if (row === undefined || row.variant !== "user") continue;
    if (row.steering === true) return null;
    const at = Date.parse(row.createdAt);
    if (!Number.isFinite(at)) return null;
    return Math.abs(at - turnStartedAtMs) <= ANCHOR_WINDOW_MS ? row.id : null;
  }
  return null;
}
