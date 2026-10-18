/**
 * The shared frame of every line icon (docs/design/R3-MINIMAL.md section 1.7):
 * a 16 x 16 grid, a 1.5 stroke with square caps and mitre joins, no fill, and
 * the colour of the surrounding text (`currentColor`). The paint sits on the
 * root as presentation attributes, so no icon carries a colour of its own and
 * nothing needs an inline style (CSP style-src 'self'). The stroke scales with
 * the box, as drawn: 1.5 at 16, 1.31 at 14, 1.88 at 20.
 */

import type { JSX, ReactNode } from "react";

/** Sizes the design uses: 14 in dense rows, 16 by default, 20 in menus and phone bars. */
export const LINE_SIZES = [14, 16, 20] as const;
export type LineSize = (typeof LINE_SIZES)[number];

/** The edge of the grid every icon is drawn on, in viewBox units. */
export const LINE_GRID = 16;

export interface LineIconProps {
  /** Square edge in px; 14, 16 or 20, default 16. */
  readonly size?: LineSize | undefined;
  /** Extra class for layout placement; the colour rides currentColor. */
  readonly className?: string | undefined;
}

export interface LineSvgProps extends LineIconProps {
  readonly children: ReactNode;
}

export const LineSvg = ({ size = 16, className, children }: LineSvgProps): JSX.Element => (
  <svg
    width={size}
    height={size}
    viewBox={`0 0 ${LINE_GRID} ${LINE_GRID}`}
    className={className}
    fill="none"
    stroke="currentColor"
    strokeWidth={1.5}
    strokeLinecap="square"
    strokeLinejoin="miter"
    aria-hidden="true"
    focusable="false"
  >
    {children}
  </svg>
);
