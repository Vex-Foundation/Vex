/**
 * Duration chip copy for a registered act (contract C1 `durationMs`).
 *
 * THE INVARIANT THAT MATTERS: `null` is NOT zero. A never-executed,
 * auto-rejected, drained, synthetic or legacy row carries `durationMs: null`
 * and MUST render no chip at all — printing "0.0 s" would tell the operator a
 * call ran instantly when in truth it never ran. Only a real measured wall
 * clock produces a chip, and a genuine sub-millisecond measurement (`0`) is
 * still a measurement, so it prints "0 ms".
 */

/** Below this, print whole milliseconds; above, seconds with one decimal. */
const MS_CEILING = 1_000;
/** At/above one minute, print "1m 05s" instead of an unreadable "65.0 s". */
const MINUTE_MS = 60_000;

/**
 * `durationMs` → chip text, or `null` when there is nothing honest to print.
 * Rejects null/non-finite/negative; everything else is a measurement.
 */
export function formatToolDuration(durationMs: number | null): string | null {
  if (durationMs === null) return null;
  if (!Number.isFinite(durationMs) || durationMs < 0) return null;
  if (durationMs < MS_CEILING) return `${Math.round(durationMs)} ms`;
  if (durationMs < MINUTE_MS) return `${(durationMs / 1000).toFixed(1)} s`;
  const totalSeconds = Math.floor(durationMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}
