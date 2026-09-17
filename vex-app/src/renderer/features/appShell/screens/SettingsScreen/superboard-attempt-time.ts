/**
 * Relative clock for a failed link attempt: "just now" under a minute, "N min
 * ago" under an hour, "N h ago" under a day, then the local wall-clock time of
 * the attempt as zero-padded 24-hour `HH:MM`. A future timestamp (clock skew)
 * reads as "just now"; an unparseable one is reported honestly instead of
 * crashing the detail line.
 */
export function superboardAttemptTime(isoAt: string, nowMs: number = Date.now()): string {
  const atMs = Date.parse(isoAt);
  if (Number.isNaN(atMs)) return "unknown time";
  const diffMs = Math.max(0, nowMs - atMs);
  if (diffMs < 60_000) return "just now";
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const at = new Date(atMs);
  const hh = String(at.getHours()).padStart(2, "0");
  const mm = String(at.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}
