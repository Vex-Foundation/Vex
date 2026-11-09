/**
 * CellMeter: a row of cells, `value` of `max` filled (the composer context
 * meter, a budget, a limit), VEX Cloud's meter: unlit cells white at 8%, lit
 * ones 39%, the last lit one (`data-head`) 60%; past the limit (`over`) the
 * lit cells turn ink, never red. Exposes `role="meter"` so the reading is
 * not lost with the drawing. Styles: `ui-primitives/marks.css`.
 */

import type { HTMLAttributes, JSX } from "react";
import { cn } from "../../lib/utils.js";

export interface CellMeterProps
  extends Omit<HTMLAttributes<HTMLSpanElement>, "children"> {
  /** Filled cells, clamped to 0..max and rounded to a whole cell. */
  readonly value: number;
  /** Cell count. */
  readonly max?: number;
  readonly over?: boolean;
  /** Accessible name; the meter has no visible text of its own. */
  readonly label: string;
}

export function CellMeter({
  value,
  max = 10,
  over = false,
  label,
  className,
  ...rest
}: CellMeterProps): JSX.Element {
  const filled = Math.max(0, Math.min(max, Math.round(value)));
  return (
    <span
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={filled}
      className={cn("vex-cell-meter", className)}
      data-over={over ? "" : undefined}
      {...rest}
    >
      {Array.from({ length: max }, (_, index) => (
        <i
          key={index}
          data-on={index < filled ? "" : undefined}
          data-head={index === filled - 1 ? "" : undefined}
        />
      ))}
    </span>
  );
}
