/**
 * Bridge tracking-delay policy (Agent Scan Phase 2, R12). A pending bridge's
 * settlement is polled by the background sweep (`sync/bridge-activity-repair`,
 * scheduled every 120s in `sync/seed.ts`), which stamps `last_checked_at` only
 * on a SUCCESSFUL provider-status observation. When that timestamp (or, before
 * the first successful check, the row's `createdAt`) falls far behind, the
 * bridge is not simply "still settling" — its tracking is DELAYED, and the
 * renderer says so honestly instead of the reassuring "tracked automatically".
 *
 * Threshold: 10 minutes. The sweep runs every ~2 minutes, so 10 minutes is ~5
 * missed successful checks — comfortably past normal sweep jitter/backoff, so a
 * "delayed" reading is a real signal, not a false alarm.
 *
 * Pure + renderer-safe: no privileged imports, no I/O. `nowMs` is injectable so
 * the decision is deterministic under test.
 */

/** A pending bridge unchecked for this long reads as "tracking delayed" (see module doc). */
export const BRIDGE_TRACKING_STALE_MS = 10 * 60 * 1000;

/**
 * Whether a pending bridge's tracking is DELAYED: the last successful check
 * (`lastCheckedAt`, or `createdAt` when it has never been checked) is older than
 * `BRIDGE_TRACKING_STALE_MS`. An unparseable timestamp returns `false` — never
 * cry "delayed" on bad data.
 */
export function isBridgeTrackingStale(
  lastCheckedAt: string | null,
  createdAt: string,
  nowMs: number = Date.now(),
): boolean {
  const reference = lastCheckedAt ?? createdAt;
  const referenceMs = new Date(reference).getTime();
  if (Number.isNaN(referenceMs)) return false;
  return nowMs - referenceMs > BRIDGE_TRACKING_STALE_MS;
}
