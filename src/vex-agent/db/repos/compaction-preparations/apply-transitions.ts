/**
 * Compaction-preparations — the apply lifecycle.
 *
 * The cutover is DURABLE AND TWO-PHASE, and the edges here encode exactly that
 * model. Nothing about it is discretionary:
 *
 *   Tx A  `apply_requested → applying`  (`casBeginApply`)
 *         Commits on its own, preserving `apply_source` and stamping the runner
 *         lease that now owns the cutover. Committing this separately is what
 *         makes a crash DETECTABLE — an `applying` row with a dead heartbeat is
 *         a cutover that started; without Tx A there would be no such evidence.
 *
 *   Tx B  `applying → applied`  (`casMarkApplied`, caller's client, REQUIRED)
 *         Re-acquires the full lock order — session advisory lock → queued-stop
 *         gate → sessions row → this row → money rows — re-checks the stop gate,
 *         evaluates the money gate, performs the cutover, and commits the FSM
 *         flip TOGETHER with the `sessions.checkpoint_generation` bump. That
 *         atomicity is the whole reason `casMarkApplied` demands a client.
 *
 *   Pre-cutover deferral or crash  (`casDeferApply`, `recoverStuckApplying`)
 *         Returns the row to `apply_requested` — NEVER to `summary_ready`. The
 *         user's (or the agent's, or the autonomy policy's) request outlived the
 *         attempt; downgrading to `summary_ready` would silently discard it and
 *         leave a ready preparation nobody ever applies.
 *
 *   Unsatisfiable request  (`casFailApply`)
 *         A generation conflict, or a preparation that can no longer be applied,
 *         is TERMINAL `failed`. Leaving it `apply_requested` parks the session:
 *         the row stays live, the one-live-per-session index blocks every future
 *         fork, and pressure keeps climbing with no path forward.
 */

import type { PoolClient } from "pg";

import { executeWith, getPool, queryOneWith } from "../../client.js";
import { jsonb } from "../../params.js";
import { pruneCorpusIfFullyTerminal } from "./retention.js";
import { withScope } from "./transaction-scope.js";
import type { ApplySource } from "./types.js";

export type RequestApplyResult = { ok: true } | { ok: false; reason: "not_ready" };

/**
 * Queue a cutover. The UI button, the agent tool and the Full-Autonomous policy
 * all land here and NOWHERE else — none of them performs the cutover itself.
 *
 * The queued request is durable on purpose: when no runner lease is alive the
 * caller reports `no_live_runner` to the user, but the request stays on the row
 * and the next runner consumes it at its iteration boundary.
 *
 * `not_ready` is the honest answer for a row that is not `summary_ready` —
 * already requested, already applying, or never ready.
 */
export async function casRequestApply(
  id: number,
  source: ApplySource,
  client?: PoolClient,
): Promise<RequestApplyResult> {
  const rowCount = await executeWith(
    client ?? getPool(),
    `UPDATE compaction_preparations
     SET status             = 'apply_requested',
         apply_source       = $2,
         apply_requested_at = NOW()
     WHERE id = $1 AND status = 'summary_ready'`,
    [id, source],
  );
  return rowCount === 1 ? { ok: true } : { ok: false, reason: "not_ready" };
}

export type BeginApplyResult =
  | { ok: true; source: ApplySource }
  | { ok: false; reason: "not_requested" };

/**
 * Tx A of the cutover: take ownership of a queued request.
 *
 * `apply_source` is deliberately NOT overwritten — it records who asked, and the
 * consuming runner is not the asker. The stored source is RETURNED instead, so
 * the cutover can honour it (a `forced_critical` row bypasses the money gate; a
 * `ui_button` row does not).
 *
 * `apply_attempt_count` counts consumption attempts for observability only. It
 * is not a budget: a deferred cutover must remain retryable for as long as the
 * request stands, otherwise a session that is briefly unsafe to compact becomes
 * permanently uncompactable.
 */
export async function casBeginApply(
  id: number,
  runnerLeaseId: string,
  client?: PoolClient,
): Promise<BeginApplyResult> {
  const row = await queryOneWith<{ apply_source: string | null }>(
    client ?? getPool(),
    `UPDATE compaction_preparations
     SET status              = 'applying',
         apply_started_at    = NOW(),
         apply_locked_by     = $2,
         apply_heartbeat_at  = NOW(),
         apply_attempt_count = apply_attempt_count + 1
     WHERE id = $1 AND status = 'apply_requested'
     RETURNING apply_source`,
    [id, runnerLeaseId],
  );
  if (!row) return { ok: false, reason: "not_requested" };
  if (row.apply_source === null) {
    throw new Error(
      `casBeginApply: preparation id=${id} reached apply_requested with no apply_source`,
    );
  }
  return { ok: true, source: row.apply_source as ApplySource };
}

/** Owner-checked heartbeat for the apply lease, mirroring the branch leases. */
export async function applyHeartbeat(id: number, runnerLeaseId: string): Promise<boolean> {
  const rowCount = await executeWith(
    getPool(),
    `UPDATE compaction_preparations
     SET apply_heartbeat_at = NOW()
     WHERE id = $1 AND status = 'applying' AND apply_locked_by = $2`,
    [id, runnerLeaseId],
  );
  return rowCount === 1;
}

/**
 * Tx B's FSM flip. MUST be called with the cutover transaction's client so it
 * commits atomically with the archive, the summary replacement and the
 * generation bump.
 *
 * `applied_generation` is set from the row's own frozen
 * `target_checkpoint_generation`, never from a caller-supplied value, and the
 * cutover bumps the session to exactly that number.
 *
 * THE ATOMICITY IS ALSO THE RECOVERY DISCRIMINATOR. Because this flip commits
 * together with the bump, a row left `applying` proves Tx B never committed —
 * whatever the session generation says. `recoverStuckApplying` therefore reads a
 * session already sitting at this row's target as a CONFLICT (another writer,
 * in practice the deterministic critical fallback, took that generation with a
 * different summary and archive), never as proof that this cutover landed. See
 * `./recovery.ts`.
 */
export async function casMarkApplied(
  id: number,
  runnerLeaseId: string,
  client: PoolClient,
): Promise<boolean> {
  const rowCount = await executeWith(
    client,
    `UPDATE compaction_preparations
     SET status             = 'applied',
         applied_generation = target_checkpoint_generation,
         applied_at         = NOW(),
         completed_at       = NOW()
     WHERE id = $1 AND status = 'applying' AND apply_locked_by = $2`,
    [id, runnerLeaseId],
  );
  if (rowCount !== 1) return false;
  await pruneCorpusIfFullyTerminal(client, id);
  return true;
}

/**
 * Release a cutover that did not happen, back to `apply_requested`.
 *
 * Used for every PRE-cutover exit: the queued stop gate fired, the money gate
 * deferred, or the attempt failed before COMMIT. A POST-commit failure must
 * never call this — the generation has already moved and the row is `applied`;
 * rolling the FSM backwards there would re-run a cutover that already happened.
 */
export async function casDeferApply(
  id: number,
  runnerLeaseId: string,
  reason: string,
): Promise<boolean> {
  const rowCount = await executeWith(
    getPool(),
    `UPDATE compaction_preparations
     SET status             = 'apply_requested',
         apply_started_at   = NULL,
         apply_locked_by    = NULL,
         apply_heartbeat_at = NULL,
         last_error         = $3
     WHERE id = $1 AND status = 'applying' AND apply_locked_by = $2`,
    [id, runnerLeaseId, reason],
  );
  return rowCount === 1;
}

/**
 * Terminalize a request that can never be satisfied — generation conflict, or a
 * preparation whose premise no longer holds.
 *
 * Accepts both `apply_requested` and `applying`: the conflict may be discovered
 * either when the runner picks the request up or after it has taken ownership.
 * Terminal ⇒ retention crossing.
 */
export async function casFailApply(
  id: number,
  error: string,
  client?: PoolClient,
): Promise<boolean> {
  return withScope(client, async (tx) => {
    const rowCount = await executeWith(
      tx,
      `UPDATE compaction_preparations
       SET status             = 'failed',
           last_error         = $2,
           apply_locked_by    = NULL,
           apply_heartbeat_at = NULL,
           completed_at       = NOW()
       WHERE id = $1 AND status IN ('apply_requested','applying')`,
      [id, error],
    );
    if (rowCount !== 1) return false;
    await pruneCorpusIfFullyTerminal(tx, id);
    return true;
  });
}

/**
 * Record the money-state findings a `forced_critical` apply observed and then
 * deliberately ignored (C7/C15).
 *
 * Forced apply still READS the money gate — the audit trail of what was in
 * flight when we compacted anyway is exactly the evidence a later incident
 * needs. It just does not let the reading stop the cutover. Written inside the
 * cutover transaction so the audit and the action commit together: a bypass
 * recorded for an apply that then rolled back would be a false accusation.
 */
export async function recordMoneyGateBypassReasons(
  id: number,
  reasons: readonly string[],
  client: PoolClient,
): Promise<void> {
  await executeWith(
    client,
    "UPDATE compaction_preparations SET money_gate_bypass_reasons = $2::jsonb WHERE id = $1",
    [id, jsonb(reasons)],
  );
}
