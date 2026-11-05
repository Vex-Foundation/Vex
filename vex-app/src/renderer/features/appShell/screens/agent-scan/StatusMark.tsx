/**
 * THE H3 STATUS MARK for an activity row (docs/design/H3-DESKTOP.md section
 * 2.2 and Appendix A.3): a small square, 6px in a row, beside the state word
 * in caps 13. Every status has its own drawing, so a colour never stands
 * alone (VEX Cloud's StateDot, PD-03; `StateSquare`):
 *
 *   filled     solid, status green    desktop's "Confirmed" (H3's FILLED)
 *   running    blink, the hud         "Submitted, awaiting confirmation",
 *                                      "Pending" (H3's RUNNING; PD-06)
 *   failed     cross, refusal ink     "Failed", "Refunded" (H3's DID NOT
 *                                      EXECUTE, as A.3 maps it); the word in
 *                                      the refusal ink too
 *   concerned  framed ink hatch       "Status unknown": nobody knows the
 *                                      outcome, so never the failed cross
 *   unknown    empty muted frame      a status word this build has never
 *                                      heard of: never an alarm and never
 *                                      "fine"
 *   waiting    target, ink            something set and waiting on the world
 *                                      (H3's WAITING: an armed price alert on
 *                                      Markets)
 *
 * The rows' outcome rules stay where they were (`agent-scan-outcome.ts`,
 * `SessionActivityCard`'s `activityOutcome`): they decide the WORD, its
 * consequence notes ("ask Vex before retrying") and their R3 fill.
 * `outcomeStatus` only reads that answer into H3's families, so the words a
 * row ends in are unchanged by the restyle.
 *
 * The square is decoration (`aria-hidden`): the word beside it says the state,
 * so nothing is announced twice. The word is written in sentence case and
 * set in caps by the sheet (section 2.3). Styles: `.vex-status-mark` in
 * `styles/global-css/book.css`, the square's drawings in
 * `ui-primitives/marks.css`.
 */

import type { JSX } from "react";
import type { SwatchState } from "../../../../components/ui/swatch.js";
import { StateSquare, type StateSquareState } from "../../../../components/ui/state-square.js";

/** H3's status families: each one's drawing. */
export type StatusFamily = "filled" | "running" | "failed" | "concerned" | "unknown" | "waiting";

/** The square each family draws. */
export const STATUS_FAMILY_SQUARE: Readonly<Record<StatusFamily, StateSquareState>> = {
  filled: "done",
  running: "ongoing",
  failed: "error",
  concerned: "concerned",
  unknown: "idle",
  waiting: "warning",
};

/** The word the rules say when the outcome cannot be established. */
const STATUS_UNKNOWN_WORD = "Status unknown";

/**
 * The family of an outcome the row rules already decided. "Status unknown"
 * rides the rules' `error` fill, but it is no failure: nobody knows, so it
 * takes the concerned hatch (VEX Cloud's status.md). `error` is otherwise the
 * rules' "did not execute" (Failed). Refunded is kept apart by those rules as
 * `idle` (the funds came back, which is not a loss), and A.3 still lists it
 * among the words H3's DID NOT EXECUTE stands for, so it takes the failed
 * cross too: desktop's mapping, kept for the owner to confirm.
 */
export function outcomeStatus(state: SwatchState, word: string): StatusFamily {
  if (state === "done") return "filled";
  if (word === STATUS_UNKNOWN_WORD) return "concerned";
  if (state === "error" || word === "Refunded") return "failed";
  if (state === "listening" || state === "ongoing" || state === "thinking") return "running";
  return "unknown";
}

export function StatusMark({
  status,
  word,
  title,
}: {
  readonly status: StatusFamily;
  /** The state in words; required, a square never stands alone. */
  readonly word: string;
  /** The full statement behind the word, when the row has one. */
  readonly title?: string;
}): JSX.Element {
  return (
    <span className="vex-status-mark" data-status={status} title={title}>
      <StateSquare state={STATUS_FAMILY_SQUARE[status]} size={6} className="vex-status-mark__sq" />
      <span className="vex-status-mark__w">{word}</span>
    </span>
  );
}
