/**
 * THE SEND CELL (docs/design/H3-DESKTOP.md sections 1.8 and 2.4, Appendix
 * A.5): the composer row's last cell, 140 wide (1300 to 1440 at 1440) and the
 * row's 72 high, the composer's one blue fill. One slot, three hard-cut
 * states:
 *  - send: the blue cell, H3's three-by-three dot glyph and SEND (sans 14,
 *    caps, white); a `type="submit"` of the composer's own form. While there
 *    is nothing to send it is disabled, and says so to assistive tech, but
 *    keeps its blue: H3 draws the resting composer, "Ask Vex..." over an
 *    empty field, with the blue SEND, so the primary key stands where the
 *    eye expects it from the first frame;
 *  - stop: the same blue cell with a square and STOP, while a turn runs. The
 *    key's word is short, its NAME says what it stops ("Stop agent" in a
 *    chat, "Stop mission" in a mission), because a stop names its target;
 *  - stopping: the same box, disabled, on the cell fill with muted words
 *    (section 2.4's disabled key), until the stop is acknowledged.
 * The word is written in sentence case and set in caps by the sheet, so a
 * screen reader reads words; the accessible name is the full one. Focus is
 * the 2px ink ring inside the cell (section 2.4).
 *
 * Presentational only - the parent owns every state transition; the send
 * state stays a `type="submit"` descendant of the composer's own `<form>`.
 * Chrome: `.vex-composer-key`, `.vex-composer-send`, `.vex-composer-stop`
 * (console.css).
 */

import type { JSX, MouseEvent as ReactMouseEvent } from "react";
import { cn } from "../../lib/utils.js";

/**
 * The cell's frame: fixed, never shrinking; focus is the ink ring INSIDE the
 * cell (section 2.4), so a cell flush with the window's edge still shows it.
 */
const KEY_BASE =
  "vex-composer-key shrink-0 transition-colors duration-100 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus";

/** H3's send glyph: three rows of three dots, drawn in the key's ink. */
function SendGlyph(): JSX.Element {
  const at = [3, 8, 13] as const;
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      width={16}
      height={16}
      viewBox="0 0 16 16"
      className="vex-composer-key__glyph"
    >
      {at.flatMap((cy) =>
        at.map((cx) => (
          <circle key={`${String(cx)}-${String(cy)}`} cx={cx} cy={cy} r={1.75} fill="currentColor" />
        )),
      )}
    </svg>
  );
}

export interface ComposerSendControlProps {
  /**
   * Render the Stop key. Broader than `submitPending` and broader than "a
   * lease is held" - the owner (`composer-submit.ts`) computes this from
   * main's authoritative `stoppable` and fails toward SHOWING the key when
   * the runtime state is unknown. Do NOT re-derive it here.
   */
  readonly stopAvailable: boolean;
  /**
   * The Stop key's accessible name, resolved per session mode by the owner's
   * `resolveStopAffordance` ("Stop mission" / "Stop agent"). Named by
   * TARGET, because the key stops a run or an autonomous session, not a
   * generation.
   */
  readonly stopLabel: string;
  readonly stopRequested: boolean;
  readonly onStop: () => void;
  readonly submitDisabled: boolean;
  /**
   * KEEP FOCUS. A pointer press on a button steals focus from the draft, so
   * the next keystroke goes nowhere and the caret is lost. The owner
   * (`SessionComposer`) suppresses the default at MOUSEDOWN and refocuses the
   * textarea, so typing continues seamlessly through a send or a stop. Bound
   * at mousedown, not click: focus moves on the press, not the release.
   */
  readonly onKeepFocus?: (event: ReactMouseEvent<HTMLButtonElement>) => void;
}

export function ComposerSendControl({
  stopAvailable,
  stopLabel,
  stopRequested,
  onStop,
  submitDisabled,
  onKeepFocus,
}: ComposerSendControlProps): JSX.Element {
  if (stopAvailable) {
    if (stopRequested) {
      return (
        <button
          type="button"
          disabled
          aria-label="Stopping"
          data-vex-send-cell="stopping"
          className={cn("vex-composer-stop", KEY_BASE)}
        >
          <span aria-hidden="true" className="vex-composer-stop__mark" />
          <span className="vex-composer-key__word">Stopping</span>
        </button>
      );
    }
    return (
      <button
        type="button"
        onClick={onStop}
        onMouseDown={onKeepFocus}
        aria-label={stopLabel}
        data-vex-send-cell="stop"
        className={cn("vex-composer-stop", KEY_BASE)}
      >
        <span aria-hidden="true" className="vex-composer-stop__mark" />
        <span className="vex-composer-key__word">Stop</span>
      </button>
    );
  }
  return (
    <button
      type="submit"
      disabled={submitDisabled}
      onMouseDown={onKeepFocus}
      aria-label="Send message"
      data-vex-send-cell="send"
      className={cn("vex-composer-send", KEY_BASE)}
    >
      <SendGlyph />
      <span className="vex-composer-key__word">Send</span>
    </button>
  );
}
