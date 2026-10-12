/**
 * Stamp: the reversed REAL FUNDS label (docs/design/V10-SPREAD.md section 7).
 * An ink plate with paper type, never red and never blue. Every desktop
 * wallet is real, so a card that can move funds carries one. Styles:
 * `ui-primitives/marks.css`.
 */

import type { HTMLAttributes, JSX, ReactNode } from "react";
import { cn } from "../../lib/utils.js";

export interface StampProps extends HTMLAttributes<HTMLSpanElement> {
  readonly children?: ReactNode;
}

export function Stamp({
  children = "Real funds",
  className,
  ...rest
}: StampProps): JSX.Element {
  return (
    <span className={cn("vex-stamp", className)} {...rest}>
      {children}
    </span>
  );
}
