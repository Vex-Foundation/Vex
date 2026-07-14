/**
 * HlLiquidVeil (design spec §13.8) — the Hyperliquid brand liquid: two soft
 * mint→teal blobs drifting horizontally in opposite directions behind a
 * card's content, like ink in water. Pure CSS (keyframes in globals.css),
 * no canvas, no imagery; `prefers-reduced-motion` freezes it into a static
 * gradient wash via the global keyframe collapse.
 *
 * Mount inside any `relative overflow-hidden` container, BEFORE the content;
 * content needs `relative` (or an explicit z) to sit above the veil.
 */

import type { JSX } from "react";

export function HlLiquidVeil(): JSX.Element {
  return (
    <span aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
      <span className="hv-liquid-blob hv-liquid-blob--a" />
      <span className="hv-liquid-blob hv-liquid-blob--b" />
    </span>
  );
}
