/**
 * `fullBalanceSync` SINGLE-FLIGHT registry (Wave P, Blocker 3).
 *
 * ## Why this exists at the exported boundary, not at one caller
 *
 * `fullBalanceSync` is not concurrency-safe: every call mints its own
 * `snapshotGroupId` and inserts a full set of per-wallet snapshot rows, so two
 * overlapping calls produce two groups for one moment in time and corrupt the
 * `pnlVsPrev` chain for every wallet. The mutex previously guarded only the
 * user-initiated refresh, while startup, the periodic `balances` job and both
 * sync-worker branches called the unguarded function directly — so the exact
 * overlap it was written to prevent stayed reachable, and was in fact the most
 * likely one (a user pressing refresh while the 300 s periodic job runs).
 *
 * ## JOIN vs QUEUE is decided by SNAPSHOT SEMANTICS, not by convenience
 *
 * Joining an in-flight run means accepting ITS snapshot policy as your own, so a
 * caller may only join a run whose policy is at least as strong as its own:
 *
 * - `"when-settled"` may join ANYTHING. It asks for a snapshot only if nothing
 *   is in flight; an `"always"` run is strictly more, and another
 *   `"when-settled"` run is exactly the same question at the same moment.
 * - `"always"` may join only another `"always"`. Joining a `"when-settled"` run
 *   would silently return a result whose snapshot may have been SUPPRESSED —
 *   the user pressed refresh and would be told "recorded" about a cycle that
 *   recorded nothing. Those callers therefore QUEUE: they wait for the weaker
 *   run to finish and then take their own authoritative snapshot.
 *
 * A queued caller CLAIMS THE SLOT IMMEDIATELY (the registry points at the queued
 * promise, not at the run it is waiting behind). That is what stops a stream of
 * `"when-settled"` runs from starving it forever, and it lets later compatible
 * callers join the queued run instead of stacking another one behind it.
 *
 * The queued run starts even if the run ahead of it REJECTED — the failure of a
 * periodic sync is not a reason to drop a user's explicit refresh.
 */

import logger from "@utils/logger.js";
import type { FullSyncResult, SnapshotPolicy } from "../balance-sync.js";

interface InFlightRun {
  readonly policy: SnapshotPolicy;
  readonly promise: Promise<FullSyncResult>;
}

let inFlight: InFlightRun | null = null;

/**
 * May a caller wanting `requested` adopt the result of a run executing
 * `running`? See the module doc — this is a snapshot-semantics question, and the
 * only unsafe direction is `"always"` adopting a `"when-settled"` result.
 */
export function canJoinInFlightSync(requested: SnapshotPolicy, running: SnapshotPolicy): boolean {
  return requested === "when-settled" || running === "always";
}

/**
 * Run `start` under the single-flight rule, joining or queueing per the policy
 * compatibility above. `start` must be the UNGUARDED core sync.
 */
export function runSingleFlightBalanceSync(
  policy: SnapshotPolicy,
  start: () => Promise<FullSyncResult>,
): Promise<FullSyncResult> {
  const current = inFlight;
  if (!current) return claimSlot(policy, start);

  if (canJoinInFlightSync(policy, current.policy)) {
    logger.info("sync.balance.joined_in_flight", { policy, inFlightPolicy: current.policy });
    return current.promise;
  }

  logger.info("sync.balance.queued_behind_in_flight", { policy, inFlightPolicy: current.policy });
  return claimSlot(policy, () => current.promise.then(start, start));
}

function claimSlot(
  policy: SnapshotPolicy,
  start: () => Promise<FullSyncResult>,
): Promise<FullSyncResult> {
  const promise = start().finally(() => {
    // Only clear the slot if it is still OURS — a queued caller has already
    // replaced it, and clearing that would let a third run start concurrently.
    if (inFlight?.promise === promise) inFlight = null;
  });
  inFlight = { policy, promise };
  return promise;
}

/** Test seam — process state, and a suite must be able to start from a clean slot. */
export function resetBalanceSyncSingleFlight(): void {
  inFlight = null;
}
