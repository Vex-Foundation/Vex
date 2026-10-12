/**
 * Counter: the giant italic parenthetical number that opens a page, `(07)`,
 * in Instrument Serif italic (docs/design/V10-SPREAD.md section 1). Lining
 * figures, a tight line box (.86) and -.02em tracking, never selectable, and
 * never hung out of its box (no hanging punctuation). The caller sets the
 * size and the colour; the counter is decoration that repeats a number the
 * page states elsewhere, so it is `aria-hidden` unless the caller says
 * otherwise.
 */

import type { HTMLAttributes, JSX } from "react";
import { cn } from "../../lib/utils.js";

export interface CounterProps extends HTMLAttributes<HTMLSpanElement> {
  /** The figure inside the parentheses, already formatted (`07`, `0.3.1`). */
  readonly value: string;
}

export function Counter({ value, className, ...rest }: CounterProps): JSX.Element {
  return (
    <span
      aria-hidden="true"
      {...rest}
      data-vex-counter=""
      className={cn(
        "select-none whitespace-nowrap font-serif font-normal italic leading-[0.86] tracking-[-0.02em] [font-feature-settings:'lnum'_1] [font-variant-numeric:lining-nums] [hanging-punctuation:none]",
        className,
      )}
    >
      ({value})
    </span>
  );
}
