/**
 * THE H3 STATUS MARK for an activity row (docs/design/H3-DESKTOP.md section
 * 2.2 and Appendix A.3): a small square, about 6px, beside the state word in
 * caps 13, ink. The word is always ink; the square alone carries the colour,
 * and green, red and grey are the only status colours:
 *
 *   filled    status green  desktop's "Confirmed" (H3's FILLED)
 *   running   status grey   "Submitted, awaiting confirmation", "Pending"
 *                           (H3's RUNNING; desktop uses muted for every
 *                           running or pending square, section 2.1 note 4)
 *   failed    status red    "Failed", "Refunded", "Status unknown" (H3's DID
 *                           NOT EXECUTE, as A.3 maps it)
 *   unknown   a muted outline  a status word this build has never heard of:
 *                           never an alarm and never "fine"
 *   waiting   ink           something set and waiting on the world (H3's
 *                           WAITING: an armed price alert on Markets)
 *
 * The rows' outcome rules stay where they were (`agent-scan-outcome.ts`,
 * `SessionActivityCard`'s `activityOutcome`): they decide the WORD and their
 * R3 fill. `outcomeStatus` only reads that answer into H3's three colours, so
 * the words a row ends in are unchanged by the restyle.
 *
 * The square is decoration (`aria-hidden`): the word beside it says the state,
 * so nothing is announced twice. The word is written in sentence case and
 * set in caps by the sheet (section 2.3). Styles: `.vex-status-mark` in
 * `styles/global-css/book.css`.
 */

import type { JSX } from "react";
import type { SwatchState } from "../../../../components/ui/swatch.js";

/** H3's status families: the square's colour. */
export type StatusFamily = "filled" | "running" | "failed" | "unknown" | "waiting";

/**
 * The family of an outcome the row rules already decided. `error` is the
 * rules' "did not execute" (Failed and Status unknown); Refunded is kept apart
 * by those rules as `idle` (the funds came back, which is not a loss), and
 * A.3 still lists it among the words H3's DID NOT EXECUTE stands for, so it
 * takes the red square too.
 */
export function outcomeStatus(state: SwatchState, word: string): StatusFamily {
  if (state === "done") return "filled";
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
      <span className="vex-status-mark__sq" aria-hidden="true" />
      <span className="vex-status-mark__w">{word}</span>
    </span>
  );
}
