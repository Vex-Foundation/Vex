/**
 * Chip: a status swatch plus its word in bracketed Departure Mono caps
 * (docs/design/V10-SPREAD.md section 1). The word repeats what the swatch
 * says; the fill carries the meaning. `compact` drops the outline and the
 * brackets for a dense row; `onPhoto` paints the label box for a chip that
 * sits on a print. Styles: `ui-primitives/marks.css`.
 */

import type { HTMLAttributes, JSX, ReactNode } from "react";
import { cn } from "../../lib/utils.js";
import { Swatch, type SwatchState } from "./swatch.js";

export interface ChipProps extends HTMLAttributes<HTMLSpanElement> {
  readonly state: SwatchState;
  readonly children: ReactNode;
  readonly compact?: boolean;
  readonly onPhoto?: boolean;
}

export function Chip({
  state,
  children,
  compact = false,
  onPhoto = false,
  className,
  ...rest
}: ChipProps): JSX.Element {
  return (
    <span
      className={cn("vex-chip", className)}
      data-s={state}
      data-compact={compact ? "" : undefined}
      data-on-photo={onPhoto ? "" : undefined}
      {...rest}
    >
      <Swatch state={state} size={compact ? 9 : 10} />
      <b>{children}</b>
    </span>
  );
}
