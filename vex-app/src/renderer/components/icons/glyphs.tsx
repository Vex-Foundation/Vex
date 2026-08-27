/**
 * glyphs - the shell's inline-SVG icon set (public entry point; the drawings
 * live in the same-named sibling folder, split by category).
 *
 * Contract: every glyph is a React component taking `{size?, className?}`,
 * drawn on a 24 viewBox, painted with currentColor, and marked `aria-hidden`
 * so it never enters an accessible name. Call sites import glyphs from
 * `components/icons/index.js`, never from this file directly.
 */

export type { GlyphProps } from "./glyphs/props.js";
export * from "./glyphs/navigation.js";
export * from "./glyphs/actions.js";
export * from "./glyphs/status.js";
export * from "./glyphs/objects.js";
export * from "./glyphs/market.js";
export * from "./glyphs/theme.js";
