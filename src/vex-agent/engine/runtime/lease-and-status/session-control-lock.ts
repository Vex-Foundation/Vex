/**
 * The SESSION CONTROL LOCK — the one serialization boundary shared by
 * operator Stop and every irreversible step that must not happen after it.
 *
 * ## Why a row lock is not enough
 *
 * `control-request-locks.ts` locks the control-request rows that ALREADY
 * exist. Under `READ COMMITTED` that cannot stop a NEW `stop_terminal` row
 * being INSERTED a microsecond later: the row the second transaction wants to
 * exclude has no identity yet, so there is nothing to lock. Every "I checked
 * and the operator had not stopped" decision built on row locks alone is
 * therefore a read of the past, not a boundary.
 *
 * A transaction-scoped Postgres advisory lock keyed on the SESSION has the one
 * property the row lock lacks: it exists whether or not any row does. Taking
 * it around both the Stop INSERT and the decisions that must observe it turns
 * "Stop arrived at an unlucky moment" into a strict order — either the stop is
 * visible to the decision, or the decision was already committed when the stop
 * was inserted.
 *
 * ## Global lock order (non-negotiable)
 *
 *   0. THIS lock — `pg_advisory_xact_lock` on the session key;
 *   1. every OPEN (`pending` | `observed`) `runtime_control_requests` row for
 *      the session, ordered `(created_at ASC, id ASC)`
 *      (`control-request-locks.ts`);
 *   2. the `mission_runs` row;
 *   3. the session's pending `approval_queue` rows;
 *   4. money-state rows (`wallet_intents`, `approval_intents`,
 *      `protocol_executions`, `agent_activity`) — see the compaction gate
 *      section below.
 *
 * A transaction may take any PREFIX-CONSISTENT subset, never out of order.
 * Because this lock is always taken FIRST, it can never be the second edge of
 * a cycle, so it cannot deadlock against the existing REQUESTS → RUN scheme —
 * it only serializes transactions that would previously have interleaved.
 * The existing deadlock-freedom argument for steps 1–2 (identical row set,
 * identical `ORDER BY`, request lock never re-taken after the run lock) is
 * untouched.
 *
 * Re-entrant by construction: Postgres reference-counts advisory locks per
 * transaction, so a nested acquisition inside an already-locked transaction
 * (e.g. `applyUserStopWithClient` called from `observeAndApplyControl`) is a
 * cheap no-op and needs no "do I already hold it?" bookkeeping. Xact-scoped,
 * so Postgres releases it at COMMIT/ROLLBACK and there is no unlock call to
 * forget — a process that dies mid-transaction cannot strand the lock.
 *
 * ## Hold duration is a safety property, not an implementation detail
 *
 * Every holder of this lock does DB work only. NOTHING may hold it across a
 * provider call, a wallet/signing call, or any other unbounded external
 * operation: a stuck HTTP call would otherwise block the operator's Stop
 * itself, which is the exact opposite of what this lock exists for. The
 * approved-dispatch gate (`operator-stop-boundary.ts`) is written around that
 * constraint — it commits and releases BEFORE `dispatchTool` runs.
 *
 * ## Second participant: the compaction safe-moment gate (contract C7)
 *
 * Operator Stop is no longer the only thing this boundary serializes. The
 * compaction APPLY cutover rewrites a session's transcript, and it may only do
 * so at a moment with no unresolved money state. It reads that state through
 * `db/repos/approval-intents/money-state.ts` INSIDE its own transaction, under
 * this lock.
 *
 * That read is a boundary only if the WRITERS take the lock too — for exactly
 * the reason in "Why a row lock is not enough" above: a wallet intent or an
 * approval row that does not exist yet cannot be locked, so a gate built on row
 * locks alone would read `clear` a microsecond before money state appeared.
 *
 * Every money-state writer therefore does, in ONE short transaction:
 * take this lock FIRST → perform the CAS → COMMIT — and only THEN makes any
 * signing or provider call. The hold-duration rule below is what forces the
 * commit to come first, and it applies to these writers with no exception: a
 * wallet writer that held this lock across a broadcast would block the
 * operator's Stop with a fund transfer.
 *
 * The lock order is unchanged; money rows are simply the LAST step, after the
 * session row. See the money-state module header for the participant inventory.
 *
 * ## Key derivation lives here and nowhere else
 *
 * The namespace prefix keeps this key space distinct from the other
 * session-keyed advisory lock in the tree (`missions.lockSessionForRenew`,
 * which hashes the bare session id). Both are taken FIRST in their respective
 * transactions, so even the astronomically unlikely hash collision costs only
 * spurious serialization between two unrelated sessions — never a cycle.
 */

import type { PoolClient } from "pg";
import { executeWith, withTransaction } from "../../../db/client.js";

/** Prefix that separates this key space from every other advisory lock. */
export const SESSION_CONTROL_LOCK_NAMESPACE = "vex:session-control";

/** The ONE place the advisory-lock key is derived from a session id. */
export function sessionControlLockKey(sessionId: string): string {
  return `${SESSION_CONTROL_LOCK_NAMESPACE}:${sessionId}`;
}

/**
 * Take the session control lock on the caller's transaction. MUST be the
 * FIRST lock the transaction acquires (see the module header's global order).
 * Blocks until any other holder for the same session commits or rolls back.
 */
export async function acquireSessionControlLock(
  client: PoolClient,
  sessionId: string,
): Promise<void> {
  await executeWith(
    client,
    "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
    [sessionControlLockKey(sessionId)],
  );
}

/**
 * Open a transaction, take the session control lock, run `fn`. For callers
 * that need the boundary but do not already own a transaction.
 *
 * `fn` must stay DB-only — see the hold-duration section of the module header.
 */
export async function withSessionControlLock<T>(
  sessionId: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  return withTransaction(async (client) => {
    await acquireSessionControlLock(client, sessionId);
    return fn(client);
  });
}
