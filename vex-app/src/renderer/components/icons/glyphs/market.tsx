/**
 * Market glyphs: the medallions and stat marks the board's spotlight reads by.
 *
 * Same contract as every other glyph in this folder - a 24 viewBox, painted
 * with `currentColor`, `aria-hidden`, sized by `size`. These are STROKED
 * rather than filled because they sit at 18-24px inside circular medallions
 * where a filled mark reads as a blob; the stroke weight is the one value
 * shared across the set so a row of them looks like one family.
 */

import type { JSX } from "react";
import type { GlyphProps } from "./props.js";

const STROKE = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

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
    <path d="M12 3.2c3.2 3.6 5.4 6.3 5.4 8.9a5.4 5.4 0 1 1-10.8 0c0-2.6 2.2-5.3 5.4-8.9Z" {...STROKE} />
  </svg>
);

/** Volume. Three bars of a histogram, tallest last. */
export const IconBars = ({ size = 16, className }: GlyphProps): JSX.Element => (
  <svg {...frame(size, className)}>
    <path d="M5.5 14.5v4M12 9.5v9M18.5 5.5v13" {...STROKE} />
  </svg>
);

/** Trades. Two arrows passing in opposite directions: buys against sells. */
export const IconArrowsUpDown = ({ size = 16, className }: GlyphProps): JSX.Element => (
  <svg {...frame(size, className)}>
    <path d="M8 20V4m0 0L4.5 7.5M8 4l3.5 3.5M16 4v16m0 0 3.5-3.5M16 20l-3.5-3.5" {...STROKE} />
  </svg>
);

/** Pair age. A clock face with hands. */
export const IconClock = ({ size = 16, className }: GlyphProps): JSX.Element => (
  <svg {...frame(size, className)}>
    <circle cx="12" cy="12" r="8.5" {...STROKE} />
    <path d="M12 7.2V12l3.2 2" {...STROKE} />
  </svg>
);

/** Holders. Two figures: a count of wallets, not of people. */
export const IconUsers = ({ size = 16, className }: GlyphProps): JSX.Element => (
  <svg {...frame(size, className)}>
    <circle cx="9.5" cy="8.5" r="3.2" {...STROKE} />
    <path d="M3.8 19.2a5.9 5.9 0 0 1 11.4 0M16.2 5.7a3.2 3.2 0 0 1 0 5.9M17.6 13.9a5.9 5.9 0 0 1 2.9 5.3" {...STROKE} />
  </svg>
);

/** The buy/sell split. A circle with one wedge marked off. */
export const IconPie = ({ size = 16, className }: GlyphProps): JSX.Element => (
  <svg {...frame(size, className)}>
    <circle cx="12" cy="12" r="8.5" {...STROKE} />
    <path d="M12 3.5V12l6 6" {...STROKE} />
  </svg>
);

/** Promotion. A megaphone: visibility that was bought rather than earned. */
export const IconMegaphone = ({ size = 16, className }: GlyphProps): JSX.Element => (
  <svg {...frame(size, className)}>
    <path d="M4.5 10.2v3.6a2 2 0 0 0 2 2h1.8l7.9 4.2V4L8.3 8.2H6.5a2 2 0 0 0-2 2ZM19.5 9.4a3.6 3.6 0 0 1 0 5.2M8.3 16v3.6" {...STROKE} />
  </svg>
);
