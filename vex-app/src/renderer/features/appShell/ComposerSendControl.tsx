/**
 * THE SEND CELL (docs/design/H3-DESKTOP.md sections 1.8 and 2.4, Appendix
 * A.5): the composer row's last cell, 138 wide (1302 to 1440 at 1440, H3's
 * `.cmp-send`) and the row's 72 high. One slot, four hard-cut states:
 *  - send: the blue cell, the three-by-three dot glyph and SEND (sans 13,
 *    caps, white); a `type="submit"` of the composer's own form;
 *  - held: while there is nothing to send the same key is held and wears
 *    the held look (VEX Cloud's EC-04): the cell fill with a muted word and
 *    faint dots, never a blue key that does nothing. It turns blue the moment
 *    the draft has text; which drafts can be sent is the owner's rule, not
 *    this cell's. Held is `aria-disabled`, never native `disabled` (VEX
 *    Cloud's `SubmitButton`, dock contract section 3): the key stays in the
 *    tab order and keeps focus through a send, its press does nothing, and
 *    it is described by why ("Write a message to send");
 *  - stop: the same blue cell with a square and STOP, while a turn runs. The
 *    key's word is short, its NAME says what it stops ("Stop agent" in a
 *    chat, "Stop mission" in a mission), because a stop names its target;
 *  - stopping: the same box, disabled, on the cell fill with muted words
 *    (section 2.4's held key), until the stop is acknowledged.
 * The word is written in sentence case and set in caps by the sheet, so a
 * screen reader reads words; the accessible name is the full one. Focus is
 * the 2px ink ring inside the cell (section 2.4). SEND names its key
 * (`aria-keyshortcuts`, and the tooltip over it, "Send message (Enter)"),
 * from the person's own Enter setting (`composer-submission-policy.ts`).
 *
 * Presentational only - the parent owns every state transition; the send
 * state stays a `type="submit"` descendant of the composer's own `<form>`.
 * Chrome: `.vex-composer-key`, `.vex-composer-send`, `.vex-composer-stop`
 * (console.css).
 */

import { useId, type JSX, type MouseEvent as ReactMouseEvent } from "react";
import { Tooltip } from "../../components/ui/tooltip.js";
import { useSubmitKeyBehavior } from "../../lib/composer-submission-policy.js";
import { cn } from "../../lib/utils.js";
import { studioPlatform } from "./studio/keybindings-labels.js";

/** Why SEND is held, said to assistive technology (VEX Cloud's words). */
export const SEND_HELD_REASON = "Write a message to send";

/**
 * The chord that sends, as `aria-keyshortcuts` spells it and as the tooltip
 * says it: Enter, or Cmd or Ctrl with Enter under the "mod-enter" setting.
 */
function sendChord(behavior: "enter" | "mod-enter"): { readonly aria: string; readonly words: string } {
  if (behavior === "enter") return { aria: "Enter", words: "Enter" };
  return studioPlatform === "darwin"
    ? { aria: "Meta+Enter", words: "Cmd+Enter" }
    : { aria: "Control+Enter", words: "Ctrl+Enter" };
}

/**
 * The cell's frame: fixed, never shrinking; focus is the ink ring INSIDE the
 * cell (section 2.4), so a cell flush with the window's edge still shows it.
 */
const KEY_BASE =
  "vex-composer-key shrink-0 transition-colors duration-100 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus";

/**
 * The send glyph: three rows of three dots on a 24 grid, every other one
 * larger (VEX Cloud's `dots` glyph), drawn 20 square. Faint at rest, white
 * under the pointer (console.css).
 */
const SEND_DOTS: readonly (readonly [number, number, number])[] = [
  [5, 5, 1.6],
  [12, 5, 1.6],
  [19, 5, 2.6],
  [5, 12, 2.6],
  [12, 12, 2.6],
  [19, 12, 1.6],
  [5, 19, 1.6],
  [12, 19, 2.6],
  [19, 19, 1.6],
];

function SendGlyph(): JSX.Element {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      width={20}
      height={20}
      viewBox="0 0 24 24"
      className="vex-composer-key__glyph"
    >
      {SEND_DOTS.map(([cx, cy, r]) => (
        <circle key={`${String(cx)}-${String(cy)}`} cx={cx} cy={cy} r={r} fill="currentColor" />
      ))}
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
  return <SendKey held={submitDisabled} onKeepFocus={onKeepFocus} />;
}

function SendKey({
  held,
  onKeepFocus,
}: {
  readonly held: boolean;
  readonly onKeepFocus?: (event: ReactMouseEvent<HTMLButtonElement>) => void;
}): JSX.Element {
  const reasonId = useId();
  const chord = sendChord(useSubmitKeyBehavior());
  return (
    <Tooltip label={`Send message (${chord.words})`} side="top">
      <button
        type="submit"
        aria-disabled={held ? true : undefined}
        aria-describedby={held ? reasonId : undefined}
        aria-keyshortcuts={chord.aria}
        onClick={(event) => {
          // Held: the press does nothing, and focus stays on the key.
          if (held) event.preventDefault();
        }}
        onMouseDown={onKeepFocus}
        aria-label="Send message"
        data-vex-send-cell="send"
        className={cn("vex-composer-send", KEY_BASE)}
      >
        <SendGlyph />
        <span className="vex-composer-key__word">Send</span>
        {/* The reason rides inside the key, so the row keeps its three cells. */}
        {held ? (
          <span id={reasonId} className="sr-only">
            {SEND_HELD_REASON}
          </span>
        ) : null}
      </button>
    </Tooltip>
  );
}
