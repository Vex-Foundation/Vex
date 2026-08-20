/**
 * Viewport-fit hook for bottom-anchored overlays: the element's bottom edge
 * is laid out independent of its height, so it grows upward and only the top
 * edge can collide with the viewport - clamp the design cap to the space
 * between that edge and the viewport top.
 */

import { useLayoutEffect, useState } from "react";
import type { RefObject } from "react";

/** Safe distance kept to the viewport top edge (mirrors the Menu portal margin). */
const MARGIN = 12;

/**
 * Clamp a bottom-anchored overlay's max-height to the viewport.
 * @param ref - the overlay element; a null current (closed) skips measuring.
 * @param cap - design max-height in px (the clamp never exceeds it).
 * @param signal - re-measure trigger: pass the overlay's render state so
 *   anchor moves re-fit; resize/scroll re-fit while mounted.
 * @returns the max-height to apply inline, in px.
 */
export function useAnchoredMaxHeight(
  ref: RefObject<HTMLElement | null>,
  cap: number,
  signal: unknown,
): number {
  const [maxHeight, setMaxHeight] = useState(cap);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null) return;
    const fit = (): void => {
      setMaxHeight(
        Math.min(cap, Math.max(0, el.getBoundingClientRect().bottom - MARGIN)),
      );
    };
    fit();
    window.addEventListener("resize", fit);
    window.addEventListener("scroll", fit, true);
    return () => {
      window.removeEventListener("resize", fit);
      window.removeEventListener("scroll", fit, true);
    };
  }, [ref, cap, signal]);
  return maxHeight;
}
