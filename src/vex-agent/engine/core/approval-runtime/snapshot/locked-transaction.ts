/**
 * How the approve/reject snapshot transaction is OPENED — under the session
 * control lock, before any row lock.
 *
 * ## Why the snapshot builders cannot take the lock themselves
 *
 * `buildApproveSnapshot` / `buildRejectSnapshot` own every queue/intent
 * decision CAS, and a decision flips an `approval_intents` row into or out of
 * the set the compaction safe-moment gate reads
 * (`db/repos/approval-intents/money-state.ts`). So they are money-state
 * writers and must serialize with that gate on the session control lock.
 *
 * But the lock is keyed on the SESSION, and the builders learn the session only
 * from `lockAndLoadSnapshot`'s `FOR UPDATE OF i, q, s` — which is itself a row
 * lock. Acquiring the session lock after it would invert the global lock order
 * documented in `lease-and-status/session-control-lock.ts`, where money-state
 * rows are the LAST step and this lock is always edge 0. Hence the session id
 * is resolved by a cheap read BEFORE the transaction opens.
 *
 * ## Why resolving it outside the transaction is sound
 *
 * `approval_intents.session_id` is written once at INSERT and never updated, so
 * a value read outside the transaction cannot go stale. The only interleaving
 * is the row not existing yet at read time: then no lock is taken, and the
 * builder — which re-reads under `FOR UPDATE` — either still finds nothing and
 * returns `not_found` (having written nothing at all), or finds a row created
 * in between. That second case cannot occur for a real approval: `createWith`
 * runs inside the enqueue transaction, and the id only reaches a decision path
 * after that transaction has committed.
 *
 * DB-only and short. No provider, wallet or signing call runs under this lock.
 */

import type { PoolClient } from "pg";

import { queryOne, withTransaction } from "../../../../db/client.js";
import { withSessionControlLock } from "@vex-agent/engine/runtime/lease-and-status.js";

/**
 * Resolve the session that owns an approval, for lock keying only. `null` when
 * the approval has no intent row — see the module header for why that is safe.
 */
async function findSessionIdForApproval(
  approvalId: string,
): Promise<string | null> {
  const row = await queryOne<{ session_id: string }>(
    "SELECT session_id FROM approval_intents WHERE approval_id = $1",
    [approvalId],
  );
  return row?.session_id ?? null;
}

/**
 * Run a snapshot builder in one transaction that holds the session control lock
 * from its first statement.
 */
export async function withApprovalDecisionTransaction<T>(
  approvalId: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const sessionId = await findSessionIdForApproval(approvalId);
  if (sessionId === null) return withTransaction(fn);
  return withSessionControlLock(sessionId, fn);
}
