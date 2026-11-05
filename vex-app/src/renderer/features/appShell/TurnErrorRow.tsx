/**
 * THE TURN ERROR ROW (docs/design/H3-DESKTOP.md section 1.7; VEX Cloud's
 * `h3-chat-gaps`, "The turn error row, by kind", and its `.t-fail`): ONE row
 * for every kind of failure, outcome first, never a new layout:
 *
 *   div.vex-turn-error                       the 1px rule on the cell ground
 *   ├─ .vex-turn-error__body                 8 | 1fr, 14 apart, 14 18 16 16
 *   │   ├─ the red square, 8px, at 7          the outcome (decoration)
 *   │   └─ p
 *   │       ├─ the title, 15/1.45            in the refusal ink
 *   │       └─ the words, 14/1.5             in ink 2: what happened and what
 *   │                                         to do, then any detail
 *   └─ .vex-turn-error__keys                 48 high under a 1px rule: zero
 *                                             to three key cells, left to
 *                                             right in the app's order
 *
 * The keys are a strip, so a new remedy is a key, never a layout. A key cell
 * is 13 caps tracked on the raised fill, padding 0 22, with a rule at its
 * right. The row never moves focus, and it is NOT a live region: Cloud draws
 * `role="alert"`, but on desktop the notification announcer already speaks
 * each failure once (`engineErrorStore`), so a second live region would make
 * a screen reader hear the failure twice. The row is where it is READ; the
 * title and the words read as two (a hidden space between them).
 *
 * Red titles are Cloud's drawn default (its open question 4: a conflict or a
 * missing chat is not a refusal and could keep the ink); desktop takes the
 * default until the owner says otherwise. Styles: `.vex-turn-error` in
 * chat-transcript.css.
 */

import type { JSX, ReactNode } from "react";

export interface TurnErrorKey {
  /** The key's word, sentence case; the strip sets it in caps. */
  readonly label: string;
  readonly onPress: () => void;
  /** The accessible name, when the word needs context ("Dismiss error"). */
  readonly ariaLabel?: string;
}

/** At most three keys stand in the strip (Cloud's row). */
export const TURN_ERROR_MAX_KEYS = 3;

export function TurnErrorRow({
  kind,
  title,
  words,
  keys = [],
  area,
}: {
  /** The failure's kind: one row per kind, its words the kind's. */
  readonly kind: string;
  /** The outcome, in the refusal ink. */
  readonly title: string;
  /** What happened and what to do, in ink 2. */
  readonly words: ReactNode;
  /** Zero to three keys, in reading order. */
  readonly keys?: readonly TurnErrorKey[];
  /** The owner's `data-vex-area`, the row's test seam. */
  readonly area?: string;
}): JSX.Element {
  const shown = keys.slice(0, TURN_ERROR_MAX_KEYS);
  return (
    <div className="vex-turn-error" data-vex-area={area} data-vex-turn-error-kind={kind}>
      <div className="vex-turn-error__body">
        <span aria-hidden="true" className="vex-turn-error__sq" />
        <p className="vex-turn-error__text">
          <span className="vex-turn-error__title">{title}</span>
          <span className="sr-only"> </span>
          <span className="vex-turn-error__words">{words}</span>
        </p>
      </div>
      {shown.length === 0 ? null : (
        <div className="vex-turn-error__keys">
          {shown.map((key) => (
            <button
              key={key.label}
              type="button"
              className="vex-turn-error__key"
              aria-label={key.ariaLabel}
              onClick={key.onPress}
            >
              {key.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
