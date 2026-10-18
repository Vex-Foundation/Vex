/**
 * The field's send/stop key (docs/design/R3-MINIMAL.md section 7), one slot
 * with three hard-cut states:
 *  - send: a 36 x 36 key with the up arrow; a dotted blue outline while there
 *    is nothing to send, the view's one blue fill once there is;
 *  - stop: the NAMED ink key, 36 high, a 9 x 9 square before its words ("Stop
 *    agent" in a chat, "Stop mission" in a mission), because a stop names what
 *    it stops;
 *  - stopping: the same box on a dotted ink line, disabled, until the stop is
 *    acknowledged.
 * Presentational only - the parent owns every state transition; the send
 * state stays a `type="submit"` descendant of the composer's own `<form>`.
 * Chrome: `.vex-composer-send` and `.vex-composer-stop` (console.css).
 */

import type { JSX, MouseEvent as ReactMouseEvent } from "react";
import { LineArrowUp } from "../../components/icons/line/index.js";
import { cn } from "../../lib/utils.js";

/** The shared key frame: fixed, never shrinking, the focus ring offset off the field. */
const KEY_BASE =
  "shrink-0 transition-colors duration-100 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-surface-composer";

export interface ComposerSendControlProps {
  /**
   * Render the Stop key. Broader than `submitPending` and broader than "a
   * lease is held" - the owner (`composer-submit.ts`) computes this from
   * main's authoritative `stoppable` and fails toward SHOWING the key when
   * the runtime state is unknown. Do NOT re-derive it here.
   */
  readonly stopAvailable: boolean;
  /**
   * The Stop key's words and accessible name, resolved per session mode by
   * the owner's `resolveStopAffordance` ("Stop mission" / "Stop agent").
   * Named by TARGET, because the key stops a run or an autonomous session,
   * not a generation.
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
          className={cn("vex-composer-stop", KEY_BASE)}
        >
          <span aria-hidden="true" className="vex-composer-stop__mark" />
          Stopping
        </button>
      );
    }
    return (
      <button
        type="button"
        onClick={onStop}
        onMouseDown={onKeepFocus}
        aria-label={stopLabel}
        className={cn("vex-composer-stop", KEY_BASE)}
      >
        <span aria-hidden="true" className="vex-composer-stop__mark" />
        {stopLabel}
      </button>
    );
  }
  return (
    <button
      type="submit"
      disabled={submitDisabled}
      onMouseDown={onKeepFocus}
      aria-label="Send message"
      className={cn(
        "vex-composer-send inline-flex h-9 w-9 items-center justify-center",
        KEY_BASE,
      )}
    >
      <LineArrowUp size={16} />
    </button>
  );
}
