/**
 * Swatch: status shown by fill, never by colour (docs/design/R3-MINIMAL.md
 * section 5). Always beside a word: `StateWord` (state-word.tsx) is the
 * pairing every R3 surface uses.
 *
 * The V10 fills keep their names (tests and e2e read `data-s`): solid = done,
 * dot screen = ongoing (the screen steps through four positions, the only
 * state motion), target = warning, hatch = draft, empty outline = idle, ink
 * cross = error.
 *
 * R3 adds five fills as NEW values, never renames:
 *   listening  dot screen, still
 *   thinking   hatch
 *   awaiting   target (a solid inner square, 2px clear of the edge)
 *   concerned  ink hatch (ink on paper and on night, never a hue)
 *   sleeping   dotted outline
 * Working, running and done read as the solid `done` fill.
 *
 * The fill is drawn in the current text colour, so a swatch sits in any ink
 * or blue row unchanged; `error` and `concerned` always paint ink. The
 * pattern rules live in `ui-primitives/marks.css`.
 */

import type { JSX } from "react";
import { cn } from "../../lib/utils.js";

export type SwatchState =
  | "done"
  | "ongoing"
  | "warning"
  | "draft"
  | "idle"
  | "error"
  | "listening"
  | "thinking"
  | "awaiting"
  | "concerned"
  | "sleeping";

/**
 * @param state - which fill the swatch paints.
 * @param size - outer edge in px.
 * @param label - the state IN WORDS, for a site where no visible text already
 *   says it. The swatch itself is `aria-hidden`, so a surface whose only state
 *   signal is the swatch owes assistive technology this. Pass NOTHING where a
 *   visible verdict word sits beside it: a second, invisible copy of a word
 *   already on screen is announced twice.
 */
export function Swatch({ state, size = 10, className, label }: {
  readonly state: SwatchState;
  /** Outer edge in px. */
  readonly size?: number;
  readonly className?: string;
  readonly label?: string;
}): JSX.Element {
  // The labelled form WRAPS rather than annotating the swatch, so every call
  // site without a label keeps the exact element it renders.
  if (label !== undefined && label !== "") {
    return (
      <span className="inline-flex items-center">
        <Swatch state={state} size={size} className={className} />
        <span className="sr-only">{label}</span>
      </span>
    );
  }
  return (
    <span
      className={cn("vex-swatch", className)}
      data-s={state}
      style={{ width: size, height: size }}
      aria-hidden="true"
    />
  );
}
