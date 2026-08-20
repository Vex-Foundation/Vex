/**
 * Calendar-day arithmetic for the transcript's day separators (gap G12).
 * Pure local-time functions; display only.
 */

/** Local-midnight epoch ms for the given moment; NaN passes through. */
export function startOfLocalDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * True when two ISO timestamps fall on different LOCAL calendar days.
 * An unparseable timestamp on either side never starts a separator.
 */
export function crossesLocalDay(prevIso: string, nextIso: string): boolean {
  const prev = new Date(prevIso).getTime();
  const next = new Date(nextIso).getTime();
  if (Number.isNaN(prev) || Number.isNaN(next)) return false;
  return startOfLocalDay(prev) !== startOfLocalDay(next);
}

const DAY_MS = 86_400_000;

/**
 * The separator label for a row's day: "Today" / "Yesterday" relative to
 * `nowMs`, otherwise the spelled local date. Null for an unparseable stamp.
 */
export function dayLabel(iso: string, nowMs: number): string | null {
  const ms = new Date(iso).getTime();
  if (Number.isNaN(ms)) return null;
  const day = startOfLocalDay(ms);
  const today = startOfLocalDay(nowMs);
  if (day === today) return "Today";
  if (today - day === DAY_MS) return "Yesterday";
  return new Date(day).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: day < today - 300 * DAY_MS ? "numeric" : undefined,
  });
}
