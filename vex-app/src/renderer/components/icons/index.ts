/**
 * Public gate for the renderer's icon layer.
 *
 * Call sites import BOTH the renderer (`VexIcon`, `IconGlyph`) and the glyph
 * values from here. `lucide-react` is an implementation detail of this folder
 * and must not be imported anywhere else in the renderer.
 */

export { VexIcon, type IconGlyph, type VexIconProps } from "./VexIcon.js";
export * from "./icon-glyphs.js";
