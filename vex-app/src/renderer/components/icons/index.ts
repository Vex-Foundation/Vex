/**
 * Public gate for the renderer's icon layer.
 *
 * VEX's filled glyphs on the 24 grid (VEX Cloud's DG-1 set) live in
 * `glyph/` (`Glyph`); H3's nav draws them.
 * Pixel icons live in `px/` (one inline sprite, `PxIcon`). The `Icon*` names
 * are thin wrappers over px symbols so call sites need no change; WP18
 * removes the wrappers. Brand marks (`@thesvg/react`, `public/logo`,
 * `public/protocols`, `VexMark`, the two marks below) are never redrawn.
 */

export * from "./legacy-glyphs.js";
export { PxIcon, type PxIconProps, type PxSize } from "./px/PxIcon.js";
export { PxSprite } from "./px/PxSprite.js";
export { PX_NAMES, type PxName } from "./px/px-names.js";
export { IconLighter } from "./brand/IconLighter.js";
export { IconSuperboard } from "./brand/IconSuperboard.js";
export {
  Glyph,
  GLYPH_DEFAULT_SIZE,
  GLYPH_NAMES,
  type GlyphName,
  type GlyphProps as FilledGlyphProps,
} from "./glyph/Glyph.js";
