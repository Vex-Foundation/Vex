/**
 * The field's send/stop key: one fixed 40px square (reference d3) rendering
 * three hard-cut states in one slot: send (the one blue fill, a dotted blue
 * outline while there is nothing to send), stop (the ink plate) and
 * stopping. The in-flight mark lives beside this key (SessionComposer)
 * because Stop occupies the slot while a turn runs. Presentational only - the
 * parent owns every state transition; the send state stays a `type="submit"`
 * descendant of the composer's own `<form>`.
 */

import type { JSX, MouseEvent as ReactMouseEvent } from "react";
import { IconSend, IconStopFill } from "../../components/icons/index.js";
import { cn } from "../../lib/utils.js";

const SEND_KEY_BASE =
  "inline-flex h-10 w-10 shrink-0 items-center justify-center border border-transparent transition-colors duration-100 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-surface-composer";

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
   * `resolveStopAffordance` ("Stop mission" / "Stop agent"). Named by TARGET,
   * because the key stops a run or an autonomous session, not a generation.
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
          className={cn(
            SEND_KEY_BASE,
            "border-dotted border-rule-ink bg-transparent text-ink-secondary",
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
        aria-label={stopLabel}
        className={cn(
          SEND_KEY_BASE,
          "bg-rule-ink text-ink-on-primary hover:bg-button-primary-hover",
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
        "bg-button-accent text-ink-on-button-accent hover:bg-button-accent-hover disabled:cursor-not-allowed disabled:border-dotted disabled:border-accent-primary disabled:bg-transparent disabled:text-accent-primary disabled:hover:bg-transparent",
      )}
    >
      <IconSend size={16} />
    </button>
  );
}
