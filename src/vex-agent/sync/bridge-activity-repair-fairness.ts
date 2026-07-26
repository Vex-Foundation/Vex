/**
 * `bridge-activity-repair.ts` pure fair-scheduling comparator — split out
 * (Card C5, move-only) once the parent's `bridge-activity-repair-sweep.ts`
 * sibling itself crossed the repo's 500-line cap. Mirrors the production
 * `COALESCE(last_attempted_at, created_at) ASC` scheduling SQL (B6).
 */

import type { BridgeSweepRow } from "./bridge-activity-repair-contracts.js";

/** The row's fair-scheduling clock: last attempt if it was ever attempted, else creation time (B6). */
export function bridgeScheduleClock(row: Pick<BridgeSweepRow, "lastAttemptedAt" | "createdAt">): number {
  const basis = row.lastAttemptedAt ?? row.createdAt;
  const ms = Date.parse(basis);
  return Number.isNaN(ms) ? 0 : ms;
}

/**
 * Least-recently-touched first, ties broken by id for determinism. A
 * never-attempted row (`lastAttemptedAt` NULL) uses its `createdAt`, so an old
 * un-attempted row is served before a recently-attempted one — the starvation
 * guarantee. Mirrors the production SQL ordering exactly, and is applied
 * defensively in the orchestration so a mis-ordered dep still sweeps fairly.
 */
export function compareBridgeFairness(a: BridgeSweepRow, b: BridgeSweepRow): number {
  const clockDelta = bridgeScheduleClock(a) - bridgeScheduleClock(b);
  return clockDelta !== 0 ? clockDelta : a.id - b.id;
}
