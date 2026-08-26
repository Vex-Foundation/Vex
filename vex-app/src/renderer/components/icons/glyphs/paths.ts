/**
 * Path arithmetic shared by the hand-drawn glyphs.
 *
 * The glyph set speaks ONE drawing language: a filled outline painted with
 * `currentColor` and no `stroke` attribute anywhere, the way the reference
 * set is authored. A ring, which several glyphs need, is therefore two
 * concentric circles under `fill-rule: evenodd` rather than a stroked circle;
 * this helper is where that arithmetic lives so every ring in the set has the
 * same weight.
 */

/** A ring of outer radius `r` and line weight `w`, as one evenodd path. */
export function ringPath(cx: number, cy: number, r: number, w: number): string {
  const inner = r - w;
  return (
    `M${cx} ${cy - r}a${r} ${r} 0 1 0 0 ${r * 2}a${r} ${r} 0 1 0 0 ${-r * 2}Z` +
    `M${cx} ${cy - inner}a${inner} ${inner} 0 1 1 0 ${inner * 2}a${inner} ${inner} 0 1 1 0 ${-inner * 2}Z`
  );
}

/** The one line weight every hand-drawn outline in the set uses. */
export const OUTLINE_WEIGHT = 1.5;
