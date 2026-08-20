/**
 * glyphs — the rebrand's inline-SVG icon set (public entry point; the
 * drawings live in the same-named sibling folder, split by category).
 *
 * Contract: every glyph is a React component taking `{size?, className?}`,
 * drawn on a 24 viewBox, painted with currentColor. Consumers migrate here
 * from the lucide-backed `icon-glyphs` gate during phases 1-4; both gates
 * export through `components/icons/index.ts` until the sweep in F6.
 */

export type { GlyphProps } from "./glyphs/props.js";
export * from "./glyphs/navigation.js";
export * from "./glyphs/actions.js";
export * from "./glyphs/status.js";
export * from "./glyphs/objects.js";
export * from "./glyphs/theme.js";
