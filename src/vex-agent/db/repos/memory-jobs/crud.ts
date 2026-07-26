/**
 * memory_jobs CRUD — durable batch/sweep queue for the async memory_manager.
 *
 * State transitions (compact_jobs precedent):
 *   pending → running               (claim via SELECT FOR UPDATE SKIP LOCKED)
 *   running → completed             (markCompleted, owner-checked)
 *   running → pending               (markCompleted CONSUMING wake_pending — historical, see below)
 *   running → failed                (markFailed, transient; retry scheduled)
 *   running → permanently_failed    (markFailed at attempt_count >= max_attempts)
 *   failed  → pending               (next_attempt_at <= now, attempt < max)
 *   running → pending               (recoverStaleRunning: stale heartbeat)
 *
 * FIX2-SPINE round 2 (Codex final-review finding 4/C19): the async
 * `reconcile` job kind (S7) is retired end-to-end — its worker
 * (`engine/memory-manager/reconcile.ts`), every enqueue caller
 * (`memory/ledger-wake.ts`), and this repo's own `enqueueReconcileJob`/
 * `resetReconcileJob` exports are ALL deleted (Agent Scan W4 + this round).
 * Migration 044 terminalized every non-terminal reconcile row to a dead-end
 * `retired` status. Two former transitions are consequently no longer
 * reachable by any code in this repo and are removed from the list above:
 * `completed → pending` (was `enqueueReconcileJob` RE-ARM) and
 * `permanently_failed → pending` (was `resetReconcileJob`'s explicit retry).
 * `wake_pending` (S7 D-REARM) is a still-real column that `markCompleted`
 * and `recoverStaleRunning` still handle generically (see their own doc
 * comments) — nothing sets it anymore since the only setter was
 * `enqueueReconcileJob`'s conflict path, but the consumption/preservation
 * logic is left in place as inert, harmless generality rather than special-
 * cased away.
 *
 * Concurrency disciplines (S1c spec §5):
 *   - claim: FOR UPDATE SKIP LOCKED inside a transaction; attempt+1 at CLAIM.
 *     `claimNextDueJob` ONLY ever claims `job_kind='consolidate'` rows
 *     (FIX2-SPINE C19) — defense in depth even though no reconcile row can
 *     be `pending`/`failed` anymore (retired rows are a dead end and no
 *     enqueue path can create a fresh one), so a future regression that
 *     re-introduced a reconcile enqueue path could never silently get it
 *     claimed and processed as if it were a consolidate job.
 *   - heartbeat / markCompleted / markFailed: owner-checked
 *     (status='running' AND locked_by=$workerId) — a reclaimed stale worker
 *     can never mutate the new owner's row.
 *   - recoverStaleRunning: ONE transaction resets each stale job to pending AND
 *     releases its reserved|processing items (MF3) — no separate caller step.
 *     It MUST leave wake_pending untouched (S7 gate R1): a historical wake
 *     signal must survive a worker crash and be consumed on the recovered
 *     run's completion, even though nothing sets the flag anymore.
 *
 * Observability: memLog (memory/observability/logger.ts), area `job`. Only
 * allowlisted, structurally-safe meta — bounded errorCode, never a raw error.
 */

import type { PoolClient } from "pg";

import {
  executeWith,
  getPool,
  queryOneWith,
  queryWith,
  withTransaction,
  type Executor,
} from "../../client.js";
import { memLog } from "@vex-agent/memory/observability/logger.js";
import type { MemoryJobStatus } from "@vex-agent/memory/schema/memory-job-enums.js";
import {
  JOB_COLUMNS,
  mapRow,
  type JobProgress,
  type MemoryJob,
  type MemoryJobRow,
} from "./types.js";

/** Run `fn` on the provided tx client, or open a fresh transaction. */
async function inTransaction<T>(
  client: PoolClient | undefined,
  fn: (tx: PoolClient) => Promise<T>,
): Promise<T> {
  return client ? fn(client) : withTransaction(fn);
}

// ── Enqueue ──────────────────────────────────────────────────────

/**
 * Enqueue a consolidate (batch/sweep) job. Consolidate jobs have NO idempotency
 * key — each call enqueues a fresh sweep of the pending candidate pool — so this
 * is a plain insert that always returns a new row.
 */
export async function enqueueConsolidateJob(client?: PoolClient): Promise<MemoryJob> {
  const exec: Executor = client ?? getPool();
  const row = await queryOneWith<MemoryJobRow>(
    exec,
    `INSERT INTO memory_jobs (job_kind) VALUES ('consolidate')
     RETURNING ${JOB_COLUMNS}`,
  );
  if (!row) throw new Error("enqueueConsolidateJob: insert returned no row");
  const job = mapRow(row);
  memLog("job", "enqueued", { jobId: job.id, jobKind: job.jobKind });
  return job;
}

// FIX2-SPINE C19 (Codex final-review finding 4): `enqueueReconcileJob` and
// `resetReconcileJob` were removed here. The async `reconcile` job kind is
// retired end-to-end — see the file header — and these were its only
// enqueue/retry entry points. `MemoryJobRowWithInsertFlag` (types.ts) was
// this pair's only consumer and was removed with them.

// ── Claim ────────────────────────────────────────────────────────

/**
 * Claim the next due job atomically. `SELECT … FOR UPDATE SKIP LOCKED` inside a
 * transaction so concurrent workers never claim the same row; stamps
 * `running`, `locked_by`, heartbeat, `started_at`, and `attempt_count + 1` (the
 * attempt is incremented at CLAIM, compact precedent). Returns null if none due.
 *
 * ONLY ever claims `job_kind='consolidate'` (FIX2-SPINE C19 — Codex
 * final-review finding 4): defense in depth for the memory_manager executor,
 * which processes every claimed row as a consolidation — see the file header
 * for why no reconcile row can reach `pending`/`failed` anymore regardless.
 */
export async function claimNextDueJob(
  workerId: string,
  client?: PoolClient,
): Promise<MemoryJob | null> {
  return inTransaction(client, async (tx) => {
    const pick = await tx.query<{ id: number }>(
      `SELECT id FROM memory_jobs
       WHERE status IN ('pending', 'failed')
         AND job_kind = 'consolidate'
         AND attempt_count < max_attempts
         AND next_attempt_at <= NOW()
       ORDER BY created_at ASC
       LIMIT 1
       FOR UPDATE SKIP LOCKED`,
    );
    const id = pick.rows[0]?.id;
    if (id === undefined) return null;
    const updated = await tx.query<MemoryJobRow>(
      `UPDATE memory_jobs
       SET status        = 'running',
           locked_at     = NOW(),
           locked_by     = $2,
           heartbeat_at  = NOW(),
           started_at    = COALESCE(started_at, NOW()),
           attempt_count = attempt_count + 1
       WHERE id = $1
       RETURNING ${JOB_COLUMNS}`,
      [id, workerId],
    );
    const r = updated.rows[0];
    if (!r) return null;
    const job = mapRow(r);
    memLog("job", "claimed", {
      jobId: job.id,
      jobKind: job.jobKind,
      attempt: job.attemptCount,
    });
    return job;
  });
}

// ── Heartbeat / finalize (all owner-checked) ─────────────────────

/**
 * Heartbeat — owner-checked. Returns false when the claim is lost (row no longer
 * `running` or `locked_by` mismatch) so the worker can self-terminate.
 */
export async function heartbeat(
  jobId: number,
  workerId: string,
  client?: PoolClient,
): Promise<boolean> {
  const exec: Executor = client ?? getPool();
  const rowCount = await executeWith(
    exec,
    `UPDATE memory_jobs SET heartbeat_at = NOW()
     WHERE id = $1 AND status = 'running' AND locked_by = $2`,
    [jobId, workerId],
  );
  return rowCount === 1;
}

/**
 * Mark a job completed — owner-checked. Clears the lock and stamps
 * `completed_at`. Returns true iff the row was actually transitioned; a false
 * return means the claim was lost (reclaimed by recoverStaleRunning).
 *
 * S7 D-REARM flag consumption: when `wake_pending=true` (a ledger wake landed
 * while this run was in flight — its reads predate the wake's write), the row
 * goes back to `pending` with attempt_count=0 instead of `completed`, so ONE
 * more pass runs against the post-wake ledger. Extended here rather than in a
 * reconcile-only variant: the flag was only ever raised on reconcile rows by
 * the now-removed `enqueueReconcileJob`'s conflict path (FIX2-SPINE C19), so
 * consolidate completions are byte-for-byte unchanged; kept generic (rather
 * than special-cased away) so a single completion path means no call site
 * could ever forget to consume the flag. The CASE arms read the PRE-UPDATE
 * `wake_pending`; the flag itself is always cleared.
 */
export async function markCompleted(
  jobId: number,
  workerId: string,
  client?: PoolClient,
): Promise<boolean> {
  const exec: Executor = client ?? getPool();
  const row = await queryOneWith<{ status: string }>(
    exec,
    `UPDATE memory_jobs
       SET status          = CASE WHEN wake_pending THEN 'pending' ELSE 'completed' END,
           attempt_count   = CASE WHEN wake_pending THEN 0 ELSE attempt_count END,
           next_attempt_at = CASE WHEN wake_pending THEN NOW() ELSE next_attempt_at END,
           completed_at    = CASE WHEN wake_pending THEN NULL ELSE NOW() END,
           wake_pending    = FALSE,
           locked_at       = NULL,
           locked_by       = NULL,
           heartbeat_at    = NULL
     WHERE id = $1 AND status = 'running' AND locked_by = $2
     RETURNING status`,
    [jobId, workerId],
  );
  if (!row) return false;
  if (row.status === "pending") memLog("job", "wake_rearmed", { jobId });
  else memLog("job", "completed", { jobId });
  return true;
}

/**
 * Mark failed and schedule the next attempt — owner-checked. Transitions to
 * `permanently_failed` when `attempt_count >= max_attempts`, otherwise `failed`
 * with a `next_attempt_at` backoff (`nextAttemptInMs` injected by the caller for
 * deterministic tests). Returns `{ ok:false }` when the claim is lost.
 * `errorCode` is a BOUNDED code (never a raw message) stored in `last_error`.
 */
export async function markFailed(
  jobId: number,
  workerId: string,
  errorCode: string,
  nextAttemptInMs: number,
  client?: PoolClient,
): Promise<{ ok: boolean; terminal: boolean }> {
  const exec: Executor = client ?? getPool();
  const job = await queryOneWith<{
    attempt_count: number;
    max_attempts: number;
    locked_by: string | null;
    status: string;
  }>(
    exec,
    "SELECT attempt_count, max_attempts, locked_by, status FROM memory_jobs WHERE id = $1",
    [jobId],
  );
  if (!job) return { ok: false, terminal: false };
  if (job.status !== "running" || job.locked_by !== workerId) {
    // Claim lost — silently no-op; recoverStaleRunning may have reclaimed us.
    return { ok: false, terminal: false };
  }

  const terminal = job.attempt_count >= job.max_attempts;
  const rowCount = terminal
    ? await executeWith(
        exec,
        `UPDATE memory_jobs
           SET status       = 'permanently_failed',
               last_error   = $3,
               locked_at    = NULL,
               locked_by    = NULL,
               heartbeat_at = NULL,
               completed_at = NOW()
         WHERE id = $1 AND status = 'running' AND locked_by = $2`,
        [jobId, workerId, errorCode],
      )
    : await executeWith(
        exec,
        `UPDATE memory_jobs
           SET status          = 'failed',
               last_error      = $3,
               next_attempt_at = NOW() + ($4::bigint || ' milliseconds')::interval,
               locked_at       = NULL,
               locked_by       = NULL,
               heartbeat_at    = NULL
         WHERE id = $1 AND status = 'running' AND locked_by = $2`,
        [jobId, workerId, errorCode, nextAttemptInMs],
      );
  const ok = rowCount === 1;
  if (ok) {
    memLog("job", "failed", {
      jobId,
      errorCode,
      attempt: job.attempt_count,
      status: terminal ? "permanently_failed" : "failed",
    });
  }
  return { ok, terminal };
}

// ── Stale recovery (atomic: job + its items) ─────────────────────

/**
 * Worker bootstrap: reset stale `running` jobs to `pending` (with backoff) AND
 * release their `reserved|processing` items to `released`, ALL in ONE
 * transaction (MF3) — those candidates re-enter the pool for another
 * reservation. Cross-table write to memory_job_items is intentional: the
 * reset-job + release-items invariant must be atomic, so it lives here rather
 * than in a separate caller step. Returns the counts for telemetry.
 *
 * S7 gate R1: NEITHER update touches `wake_pending` — a wake flagged onto a
 * running job MUST survive the crash-recovery reset, so the recovered run's
 * completion still consumes it into one more post-wake pass. Do not "clean it
 * up" here.
 */
export async function recoverStaleRunning(
  staleThresholdMs: number,
  client?: PoolClient,
): Promise<{ jobsReset: number; jobsFailed: number; itemsReleased: number }> {
  return inTransaction(client, async (tx) => {
    // A stale running job whose attempts are EXHAUSTED (attempt is incremented at
    // claim, so attempt_count >= max_attempts on a running row means the last
    // attempt is the one that went stale) must go `permanently_failed`. Resetting
    // it to `pending` would make it UNCLAIMABLE (claimNextDueJob requires
    // attempt_count < max_attempts) AND unresettable — no exported primitive
    // resets an exhausted row back to pending (FIX2-SPINE C19 removed the only
    // one, `resetReconcileJob`, which was reconcile-only anyway) — i.e.
    // stranded forever.
    const failed = await tx.query<{ id: number }>(
      `UPDATE memory_jobs
         SET status       = 'permanently_failed',
             locked_at    = NULL,
             locked_by    = NULL,
             heartbeat_at = NULL,
             completed_at = NOW(),
             last_error   = COALESCE(last_error, 'stale_max_attempts')
       WHERE status = 'running'
         AND attempt_count >= max_attempts
         AND (heartbeat_at IS NULL
              OR heartbeat_at < NOW() - ($1::bigint || ' milliseconds')::interval)
       RETURNING id`,
      [staleThresholdMs],
    );
    // Stale running jobs with attempts remaining → pending (with backoff).
    const reset = await tx.query<{ id: number }>(
      `UPDATE memory_jobs
         SET status          = 'pending',
             locked_at       = NULL,
             locked_by       = NULL,
             heartbeat_at    = NULL,
             next_attempt_at = NOW() + ($2::bigint || ' milliseconds')::interval
       WHERE status = 'running'
         AND attempt_count < max_attempts
         AND (heartbeat_at IS NULL
              OR heartbeat_at < NOW() - ($1::bigint || ' milliseconds')::interval)
       RETURNING id`,
      [staleThresholdMs, Math.min(staleThresholdMs, 30_000)],
    );
    const jobIds = [...failed.rows.map((r) => r.id), ...reset.rows.map((r) => r.id)];
    if (jobIds.length === 0) return { jobsReset: 0, jobsFailed: 0, itemsReleased: 0 };
    // Release the active items of BOTH paths so their candidates re-enter the pool.
    const released = await tx.query(
      `UPDATE memory_job_items
         SET item_status = 'released', updated_at = NOW()
       WHERE job_id = ANY($1::int[]) AND item_status IN ('reserved', 'processing')`,
      [jobIds],
    );
    memLog("job", "recovered", { count: jobIds.length });
    return {
      jobsReset: reset.rows.length,
      jobsFailed: failed.rows.length,
      itemsReleased: released.rowCount ?? 0,
    };
  });
}

// ── Accumulators / progress / reads ──────────────────────────────

/**
 * Accumulate the job's TRUE accumulators (R4-MF2): add `llmCalls` to
 * `llm_call_count` and `costUsd` to `cost_usd`. Progress counts are NOT here —
 * they are derived via getJobProgress. Returns the updated job, or null if gone.
 */
export async function bumpJobInference(
  jobId: number,
  delta: { llmCalls?: number; costUsd?: number },
  client?: PoolClient,
): Promise<MemoryJob | null> {
  const exec: Executor = client ?? getPool();
  const row = await queryOneWith<MemoryJobRow>(
    exec,
    `UPDATE memory_jobs
       SET llm_call_count = llm_call_count + $2::int,
           cost_usd       = COALESCE(cost_usd, 0) + $3::numeric
     WHERE id = $1
     RETURNING ${JOB_COLUMNS}`,
    [jobId, delta.llmCalls ?? 0, delta.costUsd ?? 0],
  );
  return row ? mapRow(row) : null;
}

/**
 * DERIVED per-batch progress (R4-MF2): counts of memory_job_items by
 * `item_status` for this job. Cheap indexed GROUP BY (idx_mji_job_status);
 * never drifts on retry/revive because nothing is stored.
 */
export async function getJobProgress(
  jobId: number,
  client?: PoolClient,
): Promise<JobProgress> {
  const exec: Executor = client ?? getPool();
  const rows = await queryWith<{ item_status: string; n: number }>(
    exec,
    `SELECT item_status, COUNT(*)::int AS n
       FROM memory_job_items
      WHERE job_id = $1
      GROUP BY item_status`,
    [jobId],
  );
  const progress: JobProgress = {
    reserved: 0,
    processing: 0,
    done: 0,
    failed: 0,
    released: 0,
    total: 0,
  };
  for (const r of rows) {
    const n = r.n;
    progress.total += n;
    switch (r.item_status) {
      case "reserved":
        progress.reserved = n;
        break;
      case "processing":
        progress.processing = n;
        break;
      case "done":
        progress.done = n;
        break;
      case "failed":
        progress.failed = n;
        break;
      case "released":
        progress.released = n;
        break;
      default:
        // A status not in the bounded vocab is impossible (DB CHECK); ignore.
        break;
    }
  }
  return progress;
}

export async function getJobById(
  id: number,
  client?: PoolClient,
): Promise<MemoryJob | null> {
  const exec: Executor = client ?? getPool();
  const row = await queryOneWith<MemoryJobRow>(
    exec,
    `SELECT ${JOB_COLUMNS} FROM memory_jobs WHERE id = $1`,
    [id],
  );
  return row ? mapRow(row) : null;
}

/**
 * List jobs in a given status, oldest `created_at` first (worker polling order /
 * inspection). `limit` is required; a non-positive / non-finite limit → [].
 */
export async function listJobsByStatus(
  status: MemoryJobStatus,
  limit: number,
  client?: PoolClient,
): Promise<MemoryJob[]> {
  if (!Number.isFinite(limit) || limit <= 0) return [];
  const exec: Executor = client ?? getPool();
  const rows = await queryWith<MemoryJobRow>(
    exec,
    `SELECT ${JOB_COLUMNS} FROM memory_jobs
      WHERE status = $1
      ORDER BY created_at ASC
      LIMIT $2`,
    [status, Math.floor(limit)],
  );
  return rows.map(mapRow);
}
