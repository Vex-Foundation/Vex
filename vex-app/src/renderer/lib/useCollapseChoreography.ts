/**
 * Collapse choreography state for a rail column: wide content stays mounted
 * while a live collapse fades (150ms settle), the frozen expanded width is
 * remembered so the sliding track clips instead of reflowing, and the
 * rail-entry animation is armed only after a LIVE collapse (a cold-collapsed
 * mount renders the rail statically).
 */

import { useEffect, useRef, useState } from "react";

/** Wide-content unmount delay; matches the 150ms fade-out (shell.css). */
export const COLLAPSE_SETTLE_MS = 150;

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
  const [settled, setSettled] = useState(collapsed);
  useEffect(() => {
    if (!collapsed) {
      setSettled(false);
      return undefined;
    }
    const timer = window.setTimeout(() => setSettled(true), COLLAPSE_SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [collapsed]);
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
