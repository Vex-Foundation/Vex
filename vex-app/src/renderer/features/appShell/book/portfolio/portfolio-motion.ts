/**
 * The Portfolio page's one motion question: does the user prefer reduced
 * motion? The page itself does not animate (docs/design/R3-MINIMAL.md section
 * 11: motion is for a state change, never decoration); only a reordered
 * section plays its one-shot settle, and this probe turns that off.
 */

/** jsdom-safe reduced-motion probe (matchMedia may be absent in jsdom). */
export function prefersReducedMotion(): boolean {
  return (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}
