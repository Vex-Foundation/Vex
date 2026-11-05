/**
 * Cover: a value still loading, as VEX Cloud draws it (its status contract,
 * "a loading value is the parked cover, never a figure"; `.vex-cover` in
 * `ui-primitives/marks.css`). A 12 high bar on the raised fill with the
 * scan's 1px head parked at its left: never a pulse, never a sweep, and it
 * holds the box the value will take, so nothing moves when the read lands.
 *
 * Decoration (`aria-hidden`): the place that holds covers names itself as
 * loading once (one `role="status"` named "Loading").
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
