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
}: {
  /** Epoch ms the live turn started. */
  readonly startedAtMs: number;
  readonly className?: string;
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
  return <span className={className}>{label}</span>;
}
