/** Shared props contract for every inline SVG glyph in this folder. */

export interface GlyphProps {
  /** Square edge in px; defaults to 16 (14 in compact rows). */
  readonly size?: number | undefined;
  /** Extra class for layout placement; color rides currentColor. */
  readonly className?: string | undefined;
}
