/**
 * Public gate for the renderer's icon layer.
 *
 * Every glyph is an inline SVG owned by this folder; there is no icon vendor
 * behind it. Call sites import the glyph components and the shared
 * `GlyphProps` contract from here; a config object that carries an icon per
 * key types the value as `ComponentType<GlyphProps>`.
 */

export * from "./glyphs.js";
