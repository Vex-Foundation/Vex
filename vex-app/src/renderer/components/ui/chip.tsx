/**
 * Chip: a status swatch and its word in a quiet frame, sentence case
 * (docs/design/R3-MINIMAL.md section 5). The word repeats what the swatch
 * says; the fill carries the meaning and takes the one blue (`error` and
 * `concerned` paint ink). `compact` drops the frame for a dense row; `onPhoto`
 * is the word on a print, where the swatch and the word are the print's type.
 * Styles: `ui-primitives/marks.css`.
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
      <Swatch
        state={state}
        size={10}
        className={onPhoto ? undefined : "text-accent-primary"}
      />
      <b>{children}</b>
    </span>
  );
}
