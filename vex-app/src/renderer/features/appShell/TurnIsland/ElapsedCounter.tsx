/**
 * Elapsed m:ss counter, isolated so the 1s tick re-renders only this span.
 * Recomputes from `startedAtMs` each tick — interval drift cannot accumulate.
 * Mounted only while the island shows live work, so unmount is the cleanup
 * edge. Ported unchanged in behavior from the pre-island working strip.
 */

import { useEffect, useState, type JSX } from "react";

/** m:ss from elapsed ms — clamped at 0 so clock skew never prints "-1:-7". */
export function formatElapsed(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export function ElapsedCounter({
  startedAtMs,
}: {
  readonly startedAtMs: number;
}): JSX.Element {
  const [label, setLabel] = useState(() =>
    formatElapsed(Date.now() - startedAtMs),
  );
  useEffect(() => {
    const tick = (): void => setLabel(formatElapsed(Date.now() - startedAtMs));
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [startedAtMs]);
  return (
    <span className="shrink-0 tabular-nums text-[11px] text-[var(--vex-text-3)]">
      {label}
    </span>
  );
}
