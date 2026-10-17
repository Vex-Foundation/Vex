/**
 * StateWord: a state is always a fill AND a word (docs/design/R3-MINIMAL.md
 * section 5). The swatch carries the fill in the one blue (`error` and
 * `concerned` paint ink); the word is never optional, so no surface can show
 * a state by fill alone.
 *
 *   <StateWord state="done" word="Working" scope="This chat:" timer="0:02" />
 *
 * `scope` is the muted prefix ("This chat:", "This mission:", "This
 * project:"); `timer` is a slot for an elapsed counter the caller owns (a
 * shared primitive never imports a feature's ticker). `live` makes the word a
 * polite live region, for the one place a state change should be announced;
 * it is off by default so a list of rows never announces itself.
 *
 * Styles: `.vex-state-word` in `ui-primitives/marks.css`.
 */

import type { HTMLAttributes, JSX, ReactNode } from "react";
import { cn } from "../../lib/utils.js";
import { Swatch, type SwatchState } from "./swatch.js";

export interface StateWordProps extends HTMLAttributes<HTMLSpanElement> {
  readonly state: SwatchState;
  /** The state in words. Required: a fill never stands alone. */
  readonly word: string;
  /** Muted scope before the word, for example "This chat:". */
  readonly scope?: string;
  /** Elapsed time or another figure after the word, set in mono. */
  readonly timer?: ReactNode;
  /** Swatch edge in px: 10 in rows, 12 beside a state headline. */
  readonly size?: 10 | 12;
  /** Announce changes of the word politely. */
  readonly live?: boolean;
  /** Classes for the swatch, for an ink swatch on an ink frame. */
  readonly swatchClassName?: string;
}

export function StateWord({
  state,
  word,
  scope,
  timer,
  size = 10,
  live = false,
  swatchClassName,
  className,
  ...rest
}: StateWordProps): JSX.Element {
  return (
    <span
      className={cn("vex-state-word", className)}
      data-s={state}
      aria-live={live ? "polite" : undefined}
      aria-atomic={live ? true : undefined}
      {...rest}
    >
      <Swatch
        state={state}
        size={size}
        // The one blue by default; `error` and `concerned` paint ink in the
        // sheet whatever this says, and a caller may ink any other fill.
        className={cn("text-accent-primary", swatchClassName)}
      />
      <span className="vex-state-word__text">
        {scope === undefined || scope === "" ? null : (
          <span className="vex-state-word__scope">{`${scope} `}</span>
        )}
        {word}
      </span>
      {timer === undefined || timer === null ? null : (
        <span className="vex-state-word__timer">{timer}</span>
      )}
    </span>
  );
}
