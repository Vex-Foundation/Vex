/** Lighter brand paint and geometry from the shipped protocols/lighter.svg. */

import { useId, type JSX } from "react";
import type { GlyphProps } from "../glyphs/props.js";

export function IconLighter({ size = 24, className }: GlyphProps): JSX.Element {
  const id = useId();
  const markMask = `${id}-mask`;
  const markFill = `${id}-fill`;
  const markStroke = `${id}-stroke`;
  return (
    <svg
      width={size}
      height={size}
      className={className}
      viewBox="0 0 64 64"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <mask
        id={markMask}
        style={{ maskType: "luminance" }}
        maskUnits="userSpaceOnUse"
        x="0"
        y="0"
        width="64"
        height="64"
      >
        <path
          d="M32 1.333C48.937 1.333 62.667 15.063 62.667 32S48.937 62.667 32 62.667 1.333 48.937 1.333 32 15.063 1.333 32 1.333Z"
          fill="white" stroke="white" strokeWidth="2.667"
        />
      </mask>
      <g mask={`url(#${markMask})`}>
        <path
          d="M64 32C64 14.327 49.673 0 32 0S0 14.327 0 32s14.327 32 32 32 32-14.327 32-32Z"
          fill={`url(#${markFill})`}
        />
        <path
          d="m30.762 43.084-8.137 7.666V21.331l8.137-8.081v29.834Zm10.613.018-8.137 7.648V39.277l8.137-8.058v11.883Z"
          fill="white"
        />
      </g>
      <path
        d="M62.667 32c0-16.937-13.73-30.667-30.667-30.667S1.333 15.063 1.333 32 15.063 62.667 32 62.667 62.667 48.937 62.667 32Z"
        stroke={`url(#${markStroke})`} strokeWidth="2.667"
      />
      <defs>
        <linearGradient id={markFill} x1="64" y1="0" x2="0" y2="64" gradientUnits="userSpaceOnUse">
          <stop offset=".3" stopColor="#121218" />
          <stop offset=".495" stopColor="#2F2F3E" />
          <stop offset=".7" stopColor="#121218" />
        </linearGradient>
        <linearGradient id={markStroke} x1="0" y1="0" x2="64" y2="64" gradientUnits="userSpaceOnUse">
          <stop stopColor="#B3B3BD" />
          <stop offset=".3" stopColor="#2B2B30" />
          <stop offset=".505" stopColor="#121218" />
          <stop offset=".7" stopColor="#2B2B30" />
          <stop offset="1" stopColor="#B3B3BD" />
        </linearGradient>
      </defs>
    </svg>
  );
}
