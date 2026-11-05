/**
 * THE LIVE TIMER beside Vex's state word (docs/design/H3-DESKTOP.md section
 * 1.6: "THINKING 0:03"): m:ss since the live turn started, recomputed from the
 * start every second, so it never drifts and a re-render never resets it.
 * Mounted only while a turn is live (`useVexPresence().timerStartedAt`), so
 * nothing ticks while Vex rests.
 */

import { useEffect, useState, type JSX } from "react";
import { formatElapsed } from "../appShell/TurnIsland/ElapsedCounter.js";

export function VexElapsed({
  startedAtMs,
  className,
  decorative = false,
}: {
  /** Epoch ms the live turn started. */
  readonly startedAtMs: number;
  readonly className?: string;
  /**
   * Hidden from assistive technology: where the time is a picture beside a
   * word that already says the state (the Vex key, as VEX Cloud's `.vk-timer`
   * is), so a description never reads a ticking figure.
   */
  readonly decorative?: boolean;
}): JSX.Element {
  const [label, setLabel] = useState(() => formatElapsed(Date.now() - startedAtMs));
  useEffect(() => {
    const tick = (): void => {
      setLabel(formatElapsed(Date.now() - startedAtMs));
    };
    tick();
    const id = window.setInterval(tick, 1000);
    return () => {
      window.clearInterval(id);
    };
  }, [startedAtMs]);
  return (
    <span className={className} aria-hidden={decorative ? true : undefined}>
      {label}
    </span>
  );
}
