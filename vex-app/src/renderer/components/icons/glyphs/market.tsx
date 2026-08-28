/**
 * Market glyphs: the stat marks the board's spotlight and its cards read by.
 *
 * Same contract as every other glyph in this folder - a 24 viewBox, painted
 * with `currentColor`, `aria-hidden`, sized by `size`. Drawn as FILLED
 * OUTLINES with no `stroke` attribute, in the same language as the reference
 * set the rest of the folder is ported from: a 1.5 line weight on the 24
 * grid, rings as evenodd paths, arrows and hands as polygons. They sit BARE
 * in a leading slot, coloured by the row's ink, never on a disc.
 */

import type { JSX } from "react";
import type { GlyphProps } from "./props.js";
import { OUTLINE_WEIGHT, ringPath } from "./paths.js";

function frame(size: number, className: string | undefined) {
  return {
    width: size,
    height: size,
    className,
    viewBox: "0 0 24 24",
    fill: "none",
    xmlns: "http://www.w3.org/2000/svg",
    "aria-hidden": "true" as const,
  };
}

/** Liquidity. A droplet: the depth of the pool a trade has to move through. */
export const IconDroplet = ({ size = 16, className }: GlyphProps): JSX.Element => (
  <svg {...frame(size, className)}>
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M12 2.6c3.6 4 6 7.1 6 10.1a6 6 0 0 1-12 0c0-3 2.4-6.1 6-10.1Zm0 2.3c-2.9 3.3-4.5 5.8-4.5 7.8a4.5 4.5 0 0 0 9 0c0-2-1.6-4.5-4.5-7.8Z"
      fill="currentColor"
    />
  </svg>
);

/** Volume. Three bars of a histogram, tallest last. */
export const IconBars = ({ size = 16, className }: GlyphProps): JSX.Element => (
  <svg {...frame(size, className)}>
    <rect x="4.75" y="13.5" width="1.5" height="6" rx="0.75" fill="currentColor" />
    <rect x="11.25" y="8.5" width="1.5" height="11" rx="0.75" fill="currentColor" />
    <rect x="17.75" y="4.5" width="1.5" height="15" rx="0.75" fill="currentColor" />
  </svg>
);

/** Trades. Two arrows passing in opposite directions: buys against sells. */
export const IconArrowsUpDown = ({ size = 16, className }: GlyphProps): JSX.Element => (
  <svg {...frame(size, className)}>
    <path
      d="M8 3.5l4 4-1.06 1.06L8.75 6.37V19.5h-1.5V6.37L5.06 8.56 4 7.5l4-4Z"
      fill="currentColor"
    />
    <path
      d="M16 20.5l-4-4 1.06-1.06 2.19 2.19V4.5h1.5v13.13l2.19-2.19L20 16.5l-4 4Z"
      fill="currentColor"
    />
  </svg>
);

/** Pair age. A clock face with hands. */
export const IconClock = ({ size = 16, className }: GlyphProps): JSX.Element => (
  <svg {...frame(size, className)}>
    <path fillRule="evenodd" clipRule="evenodd" d={ringPath(12, 12, 8.75, OUTLINE_WEIGHT)} fill="currentColor" />
    <path d="M11.25 6.75h1.5v5.85l3.45 2-.75 1.3-4.2-2.45V6.75Z" fill="currentColor" />
  </svg>
);

/** Holders. Two figures: a count of wallets, not of people. */
export const IconUsers = ({ size = 16, className }: GlyphProps): JSX.Element => (
  <svg {...frame(size, className)}>
    <path fillRule="evenodd" clipRule="evenodd" d={ringPath(9.5, 8.5, 3.4, OUTLINE_WEIGHT)} fill="currentColor" />
    <path d="M3.05 19.5a6.45 6.45 0 0 1 12.9 0h-1.5a4.95 4.95 0 0 0-9.9 0h-1.5Z" fill="currentColor" />
    <path d="M15.6 5.05a3.9 3.9 0 0 1 0 6.9l-.7-1.33a2.4 2.4 0 0 0 0-4.24l.7-1.33Z" fill="currentColor" />
    <path d="M17.2 13.55a6.45 6.45 0 0 1 3.75 5.95h-1.5a4.95 4.95 0 0 0-2.85-4.55l.6-1.4Z" fill="currentColor" />
  </svg>
);

/** The buy/sell split. A circle with one wedge marked off. */
export const IconPie = ({ size = 16, className }: GlyphProps): JSX.Element => (
  <svg {...frame(size, className)}>
    <path fillRule="evenodd" clipRule="evenodd" d={ringPath(12, 12, 8.75, OUTLINE_WEIGHT)} fill="currentColor" />
    <path d="M11.25 4.5h1.5v7.19l5.78 5.78-1.06 1.06-6.22-6.22V4.5Z" fill="currentColor" />
  </svg>
);

/** Promotion. A megaphone: visibility that was bought rather than earned. */
export const IconMegaphone = ({ size = 16, className }: GlyphProps): JSX.Element => (
  <svg {...frame(size, className)}>
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M16.7 3.2v17.6l-8.4-4.4H6.5a2.5 2.5 0 0 1-2.5-2.5v-3.8a2.5 2.5 0 0 1 2.5-2.5h1.8l8.4-4.4Zm-1.5 2.5L8.7 9.1H6.5a1 1 0 0 0-1 1v3.8a1 1 0 0 0 1 1h2.2l6.5 3.4V5.7Z"
      fill="currentColor"
    />
    <path d="M19.2 8.4a4.4 4.4 0 0 1 0 7.2l-.9-1.2a2.9 2.9 0 0 0 0-4.8l.9-1.2Z" fill="currentColor" />
    <rect x="7.8" y="16.5" width="1.5" height="3.6" rx="0.75" fill="currentColor" />
  </svg>
);
