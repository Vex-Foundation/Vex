/**
 * Collapse choreography state for a rail column: wide content stays mounted
 * while a live collapse fades (COLLAPSE_SETTLE_MS, or not at all under reduced
 * motion - see the instant path below), the frozen expanded width is
 * remembered so the sliding track clips instead of reflowing, and the
 * rail-entry animation is armed only after a LIVE collapse (a cold-collapsed
 * mount renders the rail statically).
 */

import { useEffect, useRef, useState } from "react";
import { DURATION_BASE_MS, useReducedMotion } from "./motion/index.js";

/**
 * Wide-content unmount delay.
 *
 * TIMING PAIR with `.vex-sidebar-fading > *` in `styles/global-css/shell.css`,
 * which fades that content over `--vex-duration-base`. This side reads the JS
 * mirror of the same token rather than repeating the number, so the pair
 * cannot drift: the fade must be over before the content is unmounted, or the
 * rail layout snaps in over a half-faded column.
 */
export const COLLAPSE_SETTLE_MS = DURATION_BASE_MS;

export interface CollapseChoreography {
  /** Wide layout is rendered (expanded, or mid-collapse before settle). */
  readonly wide: boolean;
  /** Collapse in flight: freeze the width and fade content in place. */
  readonly fading: boolean;
  /** Rail layout with the entry animation armed (live collapse only). */
  readonly railIn: boolean;
  /** The expanded width to freeze at while fading. */
  readonly frozenWidth: number;
}

export function useCollapseChoreography(
  collapsed: boolean,
  width: number,
): CollapseChoreography {
  const reducedMotion = useReducedMotion();
  const [settled, setSettled] = useState(collapsed);
  useEffect(() => {
    if (!collapsed) {
      setSettled(false);
      return undefined;
    }
    // THE INSTANT PATH. base.css collapses the fade this timer is waiting for
    // to 0.01ms under `prefers-reduced-motion`, so the wait would be a wait for
    // nothing: the user who asked for less motion got a rail that took 150ms to
    // appear behind an already-finished fade. Settling in the same commit is
    // what "degrades to an instant state change" means here.
    if (reducedMotion) {
      setSettled(true);
      return undefined;
    }
    const timer = window.setTimeout(() => setSettled(true), COLLAPSE_SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [collapsed, reducedMotion]);
  const wide = !collapsed || !settled;

  const lastWideWidth = useRef(width);
  if (!collapsed) lastWideWidth.current = width;

  const everWide = useRef(!collapsed);
  if (!collapsed) everWide.current = true;

  return {
    wide,
    fading: collapsed && wide,
    railIn: !wide && everWide.current,
    frozenWidth: lastWideWidth.current,
  };
}
