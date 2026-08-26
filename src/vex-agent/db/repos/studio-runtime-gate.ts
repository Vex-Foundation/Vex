/**
 * `studio_runtime_gate` - the single-row table that carries the durable Vex
 * Studio DISPATCH GENERATION (migration 086).
 *
 * The generation is a fence, not a counter anybody reads for meaning. A Studio
 * intent records the generation current at enqueue; its dispatch-slot claim
 * requires that value to still be current. Locking Vex advances it, so every
 * intent enqueued before the lock becomes undispatchable at the instant the
 * advance commits. Unlocking advances it again, which is why a pre-lock intent
 * can never be resurrected by a later unlock: the generation is MONOTONIC and a
 * value is never reused.
 *
 * The repo owns the two statements and nothing else. The policy (when to
 * advance, and the in-memory fast pre-check) lives with the engine owner in
 * `engine/core/approval-runtime/studio/dispatch-gate.ts`.
 */

import type { PoolClient } from "pg";

import { queryOne } from "../client.js";

/**
 * Advance the generation and return the new value. `RETURNING` is what makes
 * this usable as the lock's proof: the caller learns the value that is now
 * durable, so it can update its in-memory mirror with a committed fact rather
 * than with an increment it guessed.
 */
export type StudioPendingGlobalRefusalReason = "lock" | "vex_quit";

const ADVANCE_SQL = `UPDATE studio_runtime_gate
   SET dispatch_generation = dispatch_generation + 1,
       pending_refusal_reason = COALESCE($1, pending_refusal_reason),
       pending_refusal_since = CASE
         WHEN $1::text IS NULL THEN pending_refusal_since
         ELSE COALESCE(pending_refusal_since, NOW())
       END,
       updated_at = NOW()
 WHERE id = 1
 RETURNING dispatch_generation`;

/**
 * BIGINT crosses `pg` as a string and is kept as one all the way through. It is
 * compared for equality inside SQL and never arithmetic in JavaScript, so
 * narrowing it to `number` would only add a precision cliff for no reader.
 */
export async function advanceStudioDispatchGenerationRow(
  pendingRefusalReason: StudioPendingGlobalRefusalReason | null = null,
): Promise<string | null> {
  const row = await queryOne<{ dispatch_generation: string }>(ADVANCE_SQL, [
    pendingRefusalReason,
  ]);
  return row === null ? null : String(row.dispatch_generation);
}

/** Register a global refusal obligation without changing the generation. */
export async function markStudioPendingGlobalRefusalWith(
  client: PoolClient,
  reason: StudioPendingGlobalRefusalReason,
): Promise<void> {
  await client.query(
    `UPDATE studio_runtime_gate
        SET pending_refusal_reason = $1,
            pending_refusal_since = COALESCE(pending_refusal_since, NOW()),
            updated_at = NOW()
      WHERE id = 1`,
    [reason],
  );
}

/** Read and lock the durable repair obligation in the caller's transaction. */
export async function readStudioPendingGlobalRefusalWith(
  client: PoolClient,
): Promise<StudioPendingGlobalRefusalReason | null> {
  const res = await client.query<{ pending_refusal_reason: string | null }>(
    `SELECT pending_refusal_reason
       FROM studio_runtime_gate
      WHERE id = 1
      FOR UPDATE`,
    [],
  );
  const reason = res.rows[0]?.pending_refusal_reason ?? null;
  return reason === "lock" || reason === "vex_quit" ? reason : null;
}

/** Clear only the exact obligation this transaction just repaired. */
export async function clearStudioPendingGlobalRefusalWith(
  client: PoolClient,
  reason: StudioPendingGlobalRefusalReason,
): Promise<boolean> {
  const res = await client.query(
    `UPDATE studio_runtime_gate
        SET pending_refusal_reason = NULL,
            pending_refusal_since = NULL,
            updated_at = NOW()
      WHERE id = 1
        AND pending_refusal_reason = $1
      RETURNING id`,
    [reason],
  );
  return (res.rowCount ?? 0) > 0;
}

const READ_SQL =
  "SELECT dispatch_generation FROM studio_runtime_gate WHERE id = 1 FOR SHARE";

/**
 * Read the current generation in the caller's transaction. Used by the Studio
 * ENQUEUE gate, which stamps the value onto the intent it is about to insert.
 * `FOR SHARE` makes the read serialize with a generation advance: the gate
 * either observes the committed new generation, or holds the old generation
 * stable until its transaction decides whether it may insert. The main-side
 * availability predicate is re-read after this lock is acquired, so a lock
 * transition that began while this SELECT was waiting refuses the enqueue.
 */
export async function readStudioDispatchGenerationWith(
  client: PoolClient,
): Promise<string | null> {
  const res = await client.query<{ dispatch_generation: string }>(READ_SQL, []);
  const row = res.rows[0];
  return row === undefined ? null : String(row.dispatch_generation);
}
