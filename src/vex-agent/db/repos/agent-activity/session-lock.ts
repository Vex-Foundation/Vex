/**
 * Session-control-lock participation for the `agent_activity` CAS writers.
 *
 * ## Why these writers take a lock at all
 *
 * `agent_activity.status = 'pending'` is one of the predicates the compaction
 * safe-moment gate reads (`db/repos/approval-intents/money-state.ts`): a
 * pending row is a broadcast awaiting confirmation, and a transcript rewrite
 * must not race it. That reader is only a BOUNDARY — rather than a snapshot of
 * the past — if the writers serialize with it on the same lock. A row that does
 * not exist yet cannot be row-locked, which is exactly why the gate cannot be
 * built out of row locks alone.
 *
 * ## Two directions, one rule
 *
 * Creation into `pending` is the direction that can make the gate WRONG: an
 * unlocked insert can land a microsecond after the gate read `clear`, so the
 * cutover would rewrite the transcript with a broadcast about to happen. Those
 * transactions take the lock in `swap-intent.ts` / `bridge-intent.ts`, where
 * they are already atomic with the `protocol_executions` intent row.
 *
 * Finalization out of `pending` can only ever make the gate defer when it need
 * not have, which is safe by itself — but it is locked too, so the gate's
 * answer is a strict order in BOTH directions and there is one rule to
 * remember instead of a per-writer exception list.
 *
 * ## Hold duration
 *
 * Every helper here wraps short DB-only work. An activity terminalizer may also
 * settle its linked transaction-intent and execution rows before commit, but
 * the RPC or provider lookup has ALREADY returned. No external call may ever
 * move inside one of these transactions. A writer holding this lock across a
 * provider call would block the operator's Stop, the inversion the lock exists
 * to prevent (see `engine/runtime/lease-and-status/session-control-lock.ts`).
 *
 * ## A NULL session takes no lock, deliberately
 *
 * `agent_activity.session_id` is nullable. The gate is session-scoped, so such
 * a row is outside it by construction and there is no key to serialize on.
 * Locking an arbitrary session for it would serialize unrelated work and still
 * not make the row visible to any gate. Same settled ruling as the nullable
 * `protocol_executions.session_id`.
 */

import type { PoolClient } from "pg";

import { queryOne, withTransaction } from "../../client.js";
import { acquireSessionControlLock } from "../../../engine/runtime/lease-and-status/session-control-lock.js";

/**
 * Run one CAS under the session control lock, taken as the transaction's FIRST
 * statement per the global lock order. `run` MUST stay DB-only.
 */
export async function withActivitySessionLock<T>(
  sessionId: string | null,
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  return withTransaction(async (client) => {
    if (sessionId !== null) {
      await acquireSessionControlLock(client, sessionId);
    }
    return run(client);
  });
}

/**
 * The session that owns an activity row, for lock keying only.
 *
 * Read outside the transaction on purpose: `agent_activity.session_id` is
 * written at INSERT and never updated, so the value cannot go stale, and the
 * lock must be acquired BEFORE any row lock. A missing row yields `null` and
 * the CAS then matches nothing — the same outcome the unlocked write had.
 */
export async function resolveActivitySessionByRowId(
  id: number,
): Promise<string | null> {
  const row = await queryOne<{ session_id: string | null }>(
    "SELECT session_id FROM agent_activity WHERE id = $1",
    [id],
  );
  return row?.session_id ?? null;
}

/**
 * The session that owns every activity row of one execution. All rows of a
 * `protocol_execution_id` belong to the same session, so one key covers the
 * whole multi-row CAS (`abortPlannedEvents`, `confirmBridgeExpectedFill`).
 */
export async function resolveActivitySessionByExecutionId(
  executionId: number,
): Promise<string | null> {
  const row = await queryOne<{ session_id: string | null }>(
    "SELECT session_id FROM agent_activity WHERE protocol_execution_id = $1 LIMIT 1",
    [executionId],
  );
  return row?.session_id ?? null;
}
