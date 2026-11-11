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

/**
 * The QUIET REAL FUNDS mark (docs/design/H3-DESKTOP.md section 2.2; Cloud's
 * PD-05 and EC-10): "Mainnet" beside the hatch, ink, no fill, for a page or a
 * settled card that shows real money without deciding it. Desktop is mainnet
 * only, so the word is always true. The solid `Stamp` stays where money is
 * decided. Styles: `.vex-rf` in `ui-primitives/marks.css`.
 */
export function MainnetMark({
  className,
  ...rest
}: HTMLAttributes<HTMLSpanElement>): JSX.Element {
  return (
    <span className={cn("vex-rf", className)} data-vex-real-funds-mark="quiet" {...rest}>
      Mainnet
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
