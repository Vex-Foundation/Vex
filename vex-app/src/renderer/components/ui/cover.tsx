/**
 * The loading primitives, as VEX Cloud draws them (its status contract, "a
 * loading value is the parked cover, never a figure"; docs/design/H3-DESKTOP.md
 * section 5.6). Styles in `ui-primitives/marks.css`.
 *
 *   Cover          a value still loading: a 12 high bar on the raised fill
 *                  with the scan's 1px head parked at its left (`.vex-cover`,
 *                  Cloud's `.vx-cover`). Never a pulse, never a sweep, and it
 *                  holds the box the value will take, so nothing moves when
 *                  the read lands.
 *   CoverText      a cover in a line of text (Cloud's `SkeletonText`): the
 *                  text's own line box, a 12 cover centred in it.
 *   LoadingHatch   the 14px stepping hatch beside a loading word
 *                  (`.vex-stripes`, Cloud's `.vx-stripes`), blinking once
 *                  every 1200ms, still under reduced motion and Save-Data.
 *   LoadingWord    the hatch and the word in ink at 14 (Cloud's
 *                  `.vx-loading-word`).
 *
 * Cover, CoverText and LoadingHatch are decoration (`aria-hidden`): the place
 * that holds them names itself as loading once (one `role="status"` named
 * "Loading"). LoadingWord's word is real text; its owner decides whether it
 * is announced.
 */

import type { JSX } from "react";
import { cn } from "../../lib/utils.js";

export function Cover({
  width,
  height,
  className,
}: {
  /** The value's width: a share of its row ("62%") or a length ("64px"). */
  readonly width: string;
  /** A cover that stands for a square or a control, not a line. */
  readonly height?: string;
  readonly className?: string;
}): JSX.Element {
  return (
    <span
      aria-hidden="true"
      className={cn("vex-cover", className)}
      style={height === undefined ? { width } : { width, height }}
    />
  );
}

export function CoverText({
  width,
  lineHeight,
  className,
}: {
  /** The line's width: a share of its row ("60%") or a length ("144px"). */
  readonly width: string;
  /** The line height of the text it replaces, when the parent does not set it. */
  readonly lineHeight?: string;
  readonly className?: string;
}): JSX.Element {
  return (
    <span
      aria-hidden="true"
      data-vex-cover-text=""
      className={cn("vex-cover-line", className)}
      style={lineHeight === undefined ? { width } : { width, lineHeight }}
    >
      <span className="vex-cover" />
    </span>
  );
}

export function LoadingHatch({ className }: { readonly className?: string }): JSX.Element {
  return <span aria-hidden="true" className={cn("vex-stripes", className)} />;
}

export function LoadingWord({
  word,
  className,
}: {
  readonly word: string;
  readonly className?: string;
}): JSX.Element {
  return (
    <span className={cn("vex-loading-word", className)}>
      <LoadingHatch />
      {word}
    </span>
  );
}
