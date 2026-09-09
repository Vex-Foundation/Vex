/** Lighter's bare brand mark; its inherited ink stays legible in both themes. */

import type { JSX } from "react";
import type { GlyphProps } from "../glyphs/props.js";

export function IconLighter({ size = 24, className }: GlyphProps): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      className={className}
      viewBox="12 12 40 40"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <path
        d="m30.762 43.084-8.137 7.666V21.331l8.137-8.081v29.834Zm10.613.018-8.137 7.648V39.277l8.137-8.058v11.883Z"
        fill="currentColor"
      />
    </svg>
  );
}
