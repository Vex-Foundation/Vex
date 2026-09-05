/**
 * The ACTIVITY TRANSITION FENCE: proof that no money moved while the balance
 * scan ran.
 *
 * Split out of `./publication-gate.ts` (2026-09-04) because it answers a
 * different question at a different point in the lifecycle. The in-flight
 * ledger asks "what is this cycle's money currently inside", once, under the
 * publication lock. The fence is stamped at CYCLE START by
 * `../balance-sync.ts`, minutes before the transaction exists, and compared
 * again inside it. Two owners, two clocks, one reason to change each.
 *
 * `publication-gate.ts` re-exports this module's three symbols, so every
 * existing consumer keeps its import unchanged.
 *
 * A transaction that BEGINS and SETTLES entirely inside the multi-wallet scan
 * leaves nothing in flight at publication time, yet the wallets scanned before
 * it and after it were read on opposite sides of a money movement. See
 * `FENCE_SQL` for why the fence is keyed on MONEY and no longer on
 * `updated_at`.
 */

import type { Executor } from "@vex-agent/db/client.js";

/**
 * The activity table's MONEY generation for one wallet set. Compared by VALUE,
 * so every component is read back as a stable string rather than a
 * driver-typed `Date`/`BigInt` whose equality depends on the pg type parser.
 */
export interface ActivityFence {
  readonly maxId: string;
  readonly rowCount: string;
  readonly pendingCount: string;
  readonly confirmedCount: string;
}

interface FenceRow {
  max_id: string;
  row_count: string;
  pending_count: string;
  confirmed_count: string;
}

/**
 * WHY THESE FOUR COLUMNS, AND WHY `MAX(updated_at)` IS GONE.
 *
 * The fence must move when MONEY moves during the scan and stay still when
 * bookkeeping touches a row. `MAX(updated_at)` failed the second half: every
 * bridge sweep attempt stamps `updated_at = NOW()` on a still-pending row - the
 * candidate claim (`bridge-activity-repair-production-deps.ts`), `touchLastChecked`
 * and `clearVerificationStall` (`db/repos/agent-activity/swap-lifecycle/
 * verification-bookkeeping.ts`) all do, and the sweep runs every five minutes
 * forever on an old row. That is a pure re-check of something we already knew,
 * and it was tripping `activity_transition` on cycles where nothing moved.
 *
 * Those same three writers set ONLY `updated_at`, `last_attempted_at`,
 * `last_checked_at`, `verification_attempts`, `last_verification_*` and
 * `provider_status`; every one of them is fenced with `WHERE ... status =
 * 'pending'` and none inserts, deletes or writes `status`. So all four
 * components below are invariant under a sweep touch, by construction rather
 * than by hope.
 *
 * What each component catches:
 *   max_id           a row INSERTED during the scan (a broadcast).
 *   row_count        an insert or a delete.
 *   pending_count    any transition INTO or OUT OF the in-flight state -
 *                    which is what a settlement is.
 *   confirmed_count  a confirmation specifically, so a settle-and-broadcast
 *                    pair inside one scan (pending_count unchanged) is caught.
 *
 * The one status change invisible here is `definitively_failed` <->
 * `superseded_unproven`: a relabelling of an already-dead row, where no balance
 * moves and nothing enters or leaves flight. `status` has exactly four values
 * (migration 078), so that is the complete gap.
 */
const FENCE_SQL = `
  SELECT COALESCE(MAX(id), 0)::text                                  AS max_id,
         COUNT(*)::text                                              AS row_count,
         COUNT(*) FILTER (WHERE status = 'pending')::text            AS pending_count,
         COUNT(*) FILTER (WHERE status = 'confirmed')::text          AS confirmed_count
    FROM agent_activity
   WHERE wallet_address = ANY($1::text[])`;

/**
 * Stamp the activity generation for `walletAddresses`. Call this BEFORE the
 * scan starts; the same value is handed to the publisher so the gate can prove
 * no money moved in between.
 */
export async function readActivityFence(
  executor: Executor,
  walletAddresses: readonly string[],
): Promise<ActivityFence> {
  const res = await executor.query<FenceRow>(FENCE_SQL, [[...walletAddresses]]);
  const row = res.rows[0];
  return {
    maxId: row?.max_id ?? "0",
    rowCount: row?.row_count ?? "0",
    pendingCount: row?.pending_count ?? "0",
    confirmedCount: row?.confirmed_count ?? "0",
  };
}

export function fencesMatch(a: ActivityFence, b: ActivityFence): boolean {
  return a.maxId === b.maxId
    && a.rowCount === b.rowCount
    && a.pendingCount === b.pendingCount
    && a.confirmedCount === b.confirmedCount;
}
