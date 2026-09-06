/**
 * How old the POSITION card's snapshot baseline is, in words.
 *
 * Measured on the owner's machine (2026-09-04): the card read "snapshot
 * $100.62 +$0.41" beside a live total of $62.71, and that snapshot was 31 days
 * old because publication had been withheld. A PnL against a month-old
 * baseline shown in the gain tone is stale success dressed as fresh (rule 08),
 * so the age is rendered beside the snapshot value and, past
 * `SNAPSHOT_STALE_AFTER_MS`, the delta loses its gain/loss tone.
 *
 * Pure and clock-injected so the two cases are table-testable. Coarse on
 * purpose: minutes, hours, days - the reader needs to know whether the
 * baseline is from this hour or last month, not the second.
 */

/** Past this age the PnL versus the snapshot is not a live gain or loss. */
export const SNAPSHOT_STALE_AFTER_MS = 24 * 60 * 60 * 1000;

export interface SnapshotAge {
  /** e.g. "just now", "5 min ago", "3 hours ago", "31 days ago". */
  readonly label: string;
  /** Older than `SNAPSHOT_STALE_AFTER_MS`. */
  readonly stale: boolean;
}

/**
 * `null` when the timestamp is unparseable or lies in the future (clock skew
 * between the snapshot writer and this machine): an age the card cannot
 * vouch for is not printed as a number.
 */
export function snapshotAge(
  snapshotAtIso: string,
  nowMs: number,
): SnapshotAge | null {
  const at = new Date(snapshotAtIso).getTime();
  if (Number.isNaN(at)) return null;
  const elapsedMs = nowMs - at;
  if (elapsedMs < 0) return null;
  const stale = elapsedMs > SNAPSHOT_STALE_AFTER_MS;
  const minutes = Math.floor(elapsedMs / 60_000);
  if (minutes < 1) return { label: "just now", stale };
  if (minutes < 60) return { label: `${String(minutes)} min ago`, stale };
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return { label: `${String(hours)} ${hours === 1 ? "hour" : "hours"} ago`, stale };
  }
  const days = Math.floor(hours / 24);
  return { label: `${String(days)} ${days === 1 ? "day" : "days"} ago`, stale };
}
