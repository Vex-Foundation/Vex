/**
 * Glyph: VEX's filled glyph on the 24 grid (VEX Cloud's DG-1 set, its
 * `components/icons/glyph.tsx`; docs/design/H3-DESKTOP.md section 4.6).
 *
 * The drawings are `glyph-sprite-data.ts`, a byte copy of Cloud's generated
 * file (VEX's own art, no third-party licence; owner approval 2026-11-08).
 * Cloud mounts them once as an inline sprite and clones them by `<use>`;
 * desktop draws each glyph's parts inline instead, so a glyph renders
 * wherever it is mounted (a test, a portal, the pre-shell stage) with no
 * sprite to mount first. Plain JSX from data: no HTML injection, no external
 * file, the CSP untouched.
 *
 * It paints with `currentColor` on the root (a part's `opacity` is its second
 * tone, as the cube's three faces) and is decorative: the control around it
 * carries the name. Curves, so never `shapeRendering="crispEdges"`. Sizes are
 * Cloud's: 20 by default (cells, the rail), 18 an icon key, 14 or 16 beside a
 * word, 28 an empty block's glyph.
 */

import type { JSX } from "react";
import { GLYPH_SPRITE_DATA, type GlyphName, type GlyphPart } from "./glyph-sprite-data.js";

export type { GlyphName } from "./glyph-sprite-data.js";
export { GLYPH_NAMES } from "./glyph-sprite-data.js";

/** The size of a glyph that passes none (H3's cells). */
export const GLYPH_DEFAULT_SIZE = 20;

const PARTS_BY_NAME: ReadonlyMap<GlyphName, readonly GlyphPart[]> = new Map(
  GLYPH_SPRITE_DATA.map((symbol) => [symbol.id, symbol.parts]),
);

export interface GlyphProps {
  readonly name: GlyphName;
  /** Square edge in CSS px; 20 by default. */
  readonly size?: number | undefined;
  /** Layout placement; the ink rides `currentColor`. */
  readonly className?: string | undefined;
}

/** The inner drawing of one glyph: its paths and circles, in the 24 grid. */
export function glyphParts(name: GlyphName): JSX.Element[] {
  return (PARTS_BY_NAME.get(name) ?? []).map((part) =>
    "d" in part ? (
      <path
        key={part.d}
        d={part.d}
        {...(part.evenodd === true ? { fillRule: "evenodd" as const } : {})}
        {...(part.opacity === undefined ? {} : { opacity: part.opacity })}
      />
    ) : (
      <circle key={`${String(part.cx)}-${String(part.cy)}`} cx={part.cx} cy={part.cy} r={part.r} />
    ),
  );
}

export function Glyph({ name, size = GLYPH_DEFAULT_SIZE, className }: GlyphProps): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className={className}
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
      data-glyph={name}
    >
      {glyphParts(name)}
    </svg>
  );
}
