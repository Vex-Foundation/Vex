/**
 * Stamp and Tag: the only caps in the app (docs/design/R3-MINIMAL.md
 * section 1). The stamp is the reversed REAL FUNDS label, an ink plate with
 * paper type, never red and never blue. Every desktop wallet is real, so a
 * card that can move funds carries one. The tag is the outlined risk word
 * ("High risk"); `quiet` draws it in the rule and the muted ink ("Wallet
 * broadcast"). Styles: `ui-primitives/marks.css`.
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

export interface TagProps extends HTMLAttributes<HTMLSpanElement> {
  readonly children: ReactNode;
  /** The rule outline and the muted ink, for a secondary fact. */
  readonly quiet?: boolean;
}

export function Tag({
  children,
  quiet = false,
  className,
  ...rest
}: TagProps): JSX.Element {
  return (
    <span
      className={cn("vex-tag", className)}
      data-quiet={quiet ? "" : undefined}
      {...rest}
    >
      {children}
    </span>
  );
}
