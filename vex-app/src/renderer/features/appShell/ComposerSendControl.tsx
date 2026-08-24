/**
 * The capsule's send/stop key: one fixed 34px round control (catalog
 * geometry - r999, accent fill, background-color 100ms) rendering three
 * hard-cut states in one slot: send, stop, and stopping. The in-flight
 * pending dot lives beside this key (SessionComposer) because Stop
 * occupies the slot while a turn runs. Presentational only - the parent
 * owns every state transition; the send state stays a `type="submit"`
 * descendant of the composer's own `<form>`.
 */

import type { JSX, MouseEvent as ReactMouseEvent } from "react";
import { IconSend, IconStopFill } from "../../components/icons/index.js";
import { cn } from "../../lib/utils.js";

// -translate-y-0.5: the key opts out of the toolbar row's 2px downward
// shift (reference geometry) - the circle keeps its seat while the smaller
// chips sit lower.
const SEND_KEY_BASE =
  "inline-flex h-[34px] w-[34px] shrink-0 -translate-y-0.5 items-center justify-center rounded-full transition-colors duration-100 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary focus-visible:ring-offset-2 focus-visible:ring-offset-surface-composer";

export interface ComposerSendControlProps {
  /**
   * Render the Stop key. Broader than `submitPending` and broader than "a
   * lease is held" - the owner (`composer-submit.ts`) computes this from
   * main's authoritative `stoppable` and fails toward SHOWING the key when
   * the runtime state is unknown. Do NOT re-derive it here.
   */
  readonly stopAvailable: boolean;
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
          className={cn(
            SEND_KEY_BASE,
            "bg-interactive-hover text-ink-tertiary opacity-40",
          )}
        >
          <IconStopFill size={16} />
        </button>
      );
    }
    return (
      <button
        type="button"
        onClick={onStop}
        onMouseDown={onKeepFocus}
        aria-label="Stop generating"
        className={cn(
          SEND_KEY_BASE,
          "bg-button-accent text-ink-on-button-accent hover:bg-button-accent-hover",
        )}
      >
        <IconStopFill size={16} />
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
        SEND_KEY_BASE,
        "bg-button-accent text-ink-on-button-accent hover:bg-button-accent-hover disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-button-accent",
      )}
    >
      <IconSend size={16} />
    </button>
  );
}
