/**
 * Head/tail height-cap arithmetic for long DISPLAY lists: `ceil(maxLines/2)`
 * head rows and the remainder as tail rows; a list within the cap shows
 * every row.
 *
 * CONSTRAINT: display-only. This cap must NEVER be applied to content that
 * reaches the agent's context - the agent always receives the whole payload
 * (truncation decree); only the on-screen rendering is capped.
 */

export interface HeadTailCap {
  /** Rows beyond the cap (total - maxLines); <= 0 means nothing is hidden. */
  readonly hidden: number;
  /** Whether the list is over the cap and not expanded. */
  readonly capped: boolean;
  /** Head-slice row count: `ceil(maxLines / 2)`. */
  readonly headLines: number;
  /** Tail-slice row count: the remainder after the head. */
  readonly tailLines: number;
}

/**
 * Compute the head/tail split for `total` rows against `maxLines`. Pure
 * arithmetic; the caller slices its own rows so it can layer its own
 * concerns (e.g. restoring a tail header) on top.
 */
export function headTailCap(
  total: number,
  maxLines: number,
  expanded: boolean,
): HeadTailCap {
  const hidden = total - maxLines;
  const headLines = Math.ceil(maxLines / 2);
  return {
    hidden,
    capped: hidden > 0 && !expanded,
    headLines,
    tailLines: maxLines - headLines,
  };
}
