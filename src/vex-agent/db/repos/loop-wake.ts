/**
 * Loop wake requests repo — durable substrate for `LoopDefer` and the wake
 * executor.
 *
 * Schema lives in `011_loop_wake_requests.sql`, relaxed by
 * `057_loop_wake_agent_sessions.sql`. Two shapes of wake share the table:
 *   - MISSION RUN — `missionRunId` set. Claimed by run status (`paused_wake`).
 *   - AGENT SESSION — `missionRunId` null. A Full-Autonomous agent chat has no
 *     run row, so its continuation is session-scoped and the executor claims
 *     the session lease instead. `LoopDefer` still only ever writes the
 *     mission shape.
 *
 * Rows progress one-way:
 *   pending → consumed (executor `claimDue`)
 *   pending → cancelled (ingress router `cancelForSession` on user preempt)
 *
 * Invariants enforced by the schema:
 *   - At most one pending row per session (`uniq_loop_wake_pending_per_session`
 *     partial unique index). `enqueue` relies on this via
 *     `ON CONFLICT DO NOTHING` — re-enqueueing while pending returns `null`
 *     so callers can detect the no-op without a separate pre-check.
 *   - `status` CHECK constraint — only the three known values persist.
 *
 * Exactly-once claim (`claimDue`): single UPDATE that selects due pending
 * rows via `FOR UPDATE SKIP LOCKED` and flips them to `consumed`. Using a
 * dedicated short-lived `PoolClient` so the SKIP LOCKED predicate and the
 * UPDATE live in the same transaction — race-safe across concurrent
 * executor ticks.
 *
 * Structural split: this file owns the row LIFECYCLE (enqueue, cancel, claim,
 * session-scoped primitives) and stays the public entry point. The row mapping
 * lives in `./loop-wake/row.ts` and the watch reads + promotion in
 * `./loop-wake/watch-queries.ts`, both re-exported below so no caller's import
 * changed.
 */

import type { PoolClient } from "pg";
import { getPool, query, queryOneWith, execute, executeWith } from "../client.js";
import { nullableJsonb } from "../params.js";
import { mapRow, type LoopWakeRow } from "./loop-wake/row.js";

export type { LoopWakeRequest, LoopWakeStatus } from "./loop-wake/row.js";
export {
  getPendingWithWatch,
  getPendingWithWatchType,
  promotePendingWake,
  type PromotePendingWakeInput,
  type WakeTriggeredBy,
} from "./loop-wake/watch-queries.js";

import type { LoopWakeRequest } from "./loop-wake/row.js";

// ── Enqueue ─────────────────────────────────────────────────────────

export interface EnqueueInput {
  sessionId: string;
  /** `null` schedules a session-scoped agent continuation (no run row). */
  missionRunId: string | null;
  dueAt: Date;
  reason: string | null;
  payload: Record<string, unknown> | null;
}

/**
 * Insert a pending wake row. Returns the inserted row, or `null` when a
 * pending row already exists for this session (partial unique index hits
 * `ON CONFLICT DO NOTHING`). The `LoopDefer` handler treats `null` as a
 * no-op and surfaces that back to the model so it doesn't double-enqueue.
 *
 * `client` lets a caller INSERT inside its own transaction. The agent-session
 * continuation needs that: it decides "is this session still running?" and
 * schedules the wake in ONE transaction under the session control lock, so a
 * cancellation cannot land between the decision and the insert. Sampling the
 * two separately is exactly the race that left a live wake on a stopped
 * session. Callers without that requirement omit it and get the pool.
 */
export async function enqueue(
  input: EnqueueInput,
  client?: PoolClient,
): Promise<LoopWakeRequest | null> {
  const row = await queryOneWith<LoopWakeRow>(
    client ?? getPool(),
    `INSERT INTO loop_wake_requests
       (session_id, mission_run_id, due_at, status, reason, payload)
     VALUES ($1, $2, $3::timestamptz, 'pending', $4, $5::jsonb)
     ON CONFLICT (session_id) WHERE status = 'pending' DO NOTHING
     RETURNING *`,
    [
      input.sessionId,
      input.missionRunId,
      input.dueAt.toISOString(),
      input.reason,
      nullableJsonb(input.payload),
    ],
  );
  return row ? mapRow(row) : null;
}

// ── Cancel ──────────────────────────────────────────────────────────

/**
 * Cancel every pending wake for the given session — typically called once
 * at the start of `routeUserMessage` (PR-7 ingress router) before the new
 * user message is persisted, so a freshly-preempted user turn doesn't race
 * with a wake banner injection.
 *
 * Returns the number of rows flipped pending → cancelled. Zero is normal
 * (no wake was pending). The caller must NOT treat a non-zero count as
 * an assumption that a banner hasn't already been injected — cancel loses
 * a race against an in-flight `claimDue` (see PR-7 executor re-check).
 */
export async function cancelForSession(
  sessionId: string,
  reason: string,
): Promise<number> {
  return execute(
    `UPDATE loop_wake_requests
     SET status = 'cancelled',
         cancelled_at = NOW(),
         cancelled_reason = $2
     WHERE session_id = $1 AND status = 'pending'`,
    [sessionId, reason],
  );
}

// ── Claim due (exactly-once) ────────────────────────────────────────

/**
 * Atomically claim up to `limit` pending MISSION-SCOPED wake rows whose
 * `due_at <= now`.
 *
 * SESSION-SCOPED rows (`mission_run_id IS NULL`) are deliberately excluded.
 * They are claimed by the atomic session-wake protocol
 * (`engine/wake/executor/claim-session-wake.ts`), which takes the session
 * control lock, revalidates the row and acquires the session lease as ONE
 * commit. Consuming such a row here first would reopen the window this split
 * exists to remove: between the destructive `pending → consumed` and the lease
 * acquisition there was neither a pending wake nor a lease, so a Stop landing
 * in it found nothing to stop, and a lease-busy claim had already destroyed the
 * only durable record of the continuation.
 *
 * The UPDATE takes a short-lived dedicated connection (`pool.connect()`)
 * and runs inside an explicit `BEGIN…COMMIT` so the `SELECT … FOR UPDATE
 * SKIP LOCKED` inner query and the `UPDATE … SET status='consumed'` outer
 * statement share the same transaction. That combination is the race-safe
 * contract: two parallel `claimDue` calls see disjoint row sets, because
 * the inner select skips rows that the other transaction has already
 * locked.
 *
 * Every returned row is now in status `consumed` (DB-side). Callers must
 * tolerate the row set being smaller than `limit` (possibly empty) — that
 * means either fewer rows were due or other executors raced ahead.
 */
export async function claimDue(
  now: Date,
  limit: number,
): Promise<LoopWakeRequest[]> {
  const client: PoolClient = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await client.query<LoopWakeRow>(
      `UPDATE loop_wake_requests
       SET status = 'consumed', consumed_at = NOW()
       WHERE id IN (
         SELECT id FROM loop_wake_requests
         WHERE status = 'pending'
           AND due_at <= $1::timestamptz
           AND mission_run_id IS NOT NULL
         ORDER BY due_at
         LIMIT $2
         FOR UPDATE SKIP LOCKED
       )
       RETURNING *`,
      [now.toISOString(), limit],
    );
    await client.query("COMMIT");
    return result.rows.map(mapRow);
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Swallow rollback errors — the original failure is what the caller needs.
    }
    throw err;
  } finally {
    client.release();
  }
}

// ── Session-scoped atomic claim primitives ──────────────────────────

/**
 * Due SESSION-SCOPED candidates, read WITHOUT consuming.
 *
 * Step 1 of the atomic protocol: the session identity has to be known before
 * the session control lock can be taken, and a single batch statement cannot
 * take a per-session lock. This read is therefore deliberately non-destructive
 * and its result is a CANDIDATE list — every row is revalidated under the lock
 * in `lockDueSessionScopedWith` before anything acts on it.
 */
export async function listDueSessionScoped(
  now: Date,
  limit: number,
): Promise<LoopWakeRequest[]> {
  const rows = await query<LoopWakeRow>(
    `SELECT * FROM loop_wake_requests
      WHERE status = 'pending'
        AND due_at <= $1::timestamptz
        AND mission_run_id IS NULL
      ORDER BY due_at
      LIMIT $2`,
    [now.toISOString(), limit],
  );
  return rows.map(mapRow);
}

/**
 * Re-read ONE session-scoped candidate under a row lock, inside the caller's
 * transaction, and prove it is still claimable.
 *
 * `null` means the row stopped being claimable between the candidate read and
 * this lock — cancelled by an operator Stop or by ingress preempt, or already
 * claimed by another executor. That is a normal outcome, not an error: the
 * transaction simply does nothing.
 *
 * The caller MUST already hold the session control lock (canonical order), so a
 * Stop for this session is either fully visible here or committed after this
 * transaction did.
 */
export async function lockDueSessionScopedWith(
  client: PoolClient,
  wakeId: string,
  now: Date,
): Promise<LoopWakeRequest | null> {
  const row = await queryOneWith<LoopWakeRow>(
    client,
    `SELECT * FROM loop_wake_requests
      WHERE id = $1
        AND status = 'pending'
        AND mission_run_id IS NULL
        AND due_at <= $2::timestamptz
      FOR UPDATE`,
    [wakeId, now.toISOString()],
  );
  return row ? mapRow(row) : null;
}

/**
 * Consume a locked session-scoped row. Called ONLY after the session lease was
 * successfully acquired on the same client, so `pending → consumed` and "a
 * runner now owns this session" commit together.
 */
export async function consumeLockedWith(
  client: PoolClient,
  wakeId: string,
): Promise<number> {
  return executeWith(
    client,
    `UPDATE loop_wake_requests
        SET status = 'consumed', consumed_at = NOW()
      WHERE id = $1 AND status = 'pending'`,
    [wakeId],
  );
}

/**
 * Push a locked session-scoped row's deadline out and record the attempt — the
 * lease-busy backoff, applied to the SAME row rather than to a replacement.
 *
 * The row stays `pending`, so nothing about the continuation is lost and the
 * partial unique index cannot be violated. `attempt` is telemetry: it makes a
 * contended session DIAGNOSABLE and is never a cap. Without this the overdue
 * row would be retried on every 2 s tick.
 */
export async function deferLockedWith(
  client: PoolClient,
  wakeId: string,
  dueAt: Date,
  attempt: number,
): Promise<number> {
  return executeWith(
    client,
    `UPDATE loop_wake_requests
        SET due_at  = $2::timestamptz,
            payload = COALESCE(payload, '{}'::jsonb)
                      || jsonb_build_object('attempt', $3::int)
      WHERE id = $1 AND status = 'pending'`,
    [wakeId, dueAt.toISOString(), attempt],
  );
}

// ── Read ────────────────────────────────────────────────────────────

/**
 * Fetch the current pending wake for this session, if any. Used by the
 * executor's resume-path sanity check and by ingress routing to decide
 * whether a user message is preempting a deferred turn.
 */
export async function getPendingForSession(
  sessionId: string,
): Promise<LoopWakeRequest | null> {
  const row = await queryOneWith<LoopWakeRow>(
    getPool(),
    `SELECT * FROM loop_wake_requests
     WHERE session_id = $1 AND status = 'pending'
     LIMIT 1`,
    [sessionId],
  );
  return row ? mapRow(row) : null;
}
