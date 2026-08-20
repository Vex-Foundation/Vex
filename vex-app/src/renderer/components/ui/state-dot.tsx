/**
 * StateDot: state indicator. done/warning/error: a solid core inside a
 * same-color 10%-opacity halo. ongoing: a pixel-art chase - the 8 outer
 * cells of a 3x3 matrix light up clockwise with a stepped, flat-hold trail.
 * Colors resolve through state aliases only.
 */

import type { JSX } from "react";
import { cn } from "../../lib/utils.js";

export type StateDotState = "done" | "warning" | "ongoing" | "error";

/** Outer 3x3 matrix cells (2px pixels on a 10px grid), clockwise from top-left. */
const MATRIX_CELLS: readonly (readonly [number, number])[] = [
  [0, 0], [4, 0], [8, 0], [8, 4], [8, 8], [4, 8], [0, 8], [0, 4],
];

export function StateDot({ state, size = 10, className }: {
  readonly state: StateDotState;
  /** Outer diameter in px. */
  readonly size?: number;
  readonly className?: string;
}): JSX.Element {
  if (state === "ongoing") {
    return (
      <svg
        className={cn("vex-state-matrix", className)}
        data-state="ongoing"
        width={size}
        height={size}
        viewBox="0 0 10 10"
        shapeRendering="crispEdges"
        aria-hidden="true"
      >
        {MATRIX_CELLS.map(([x, y], index) => (
          <rect
            key={`${x}-${y}`}
            className="vex-state-cell"
            x={x}
            y={y}
            width="2"
            height="2"
            /* Negative delay phases the chase so every cell animates from mount. */
            style={{ animationDelay: `${(index - MATRIX_CELLS.length) * 125}ms` }}
          />
        ))}
      </svg>
    );
  }
  return (
    <span
      className={cn("vex-state-dot", className)}
      data-state={state}
      style={{ width: size, height: size }}
      aria-hidden="true"
    />
  );
}
