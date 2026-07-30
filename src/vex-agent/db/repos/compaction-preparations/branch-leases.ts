/**
 * Compaction-preparations — the two INDEPENDENT branch leases.
 *
 * Branch A (`summary_*`) and branch B (`chunks_*`) are two different workers
 * with two different retry budgets, heartbeats and lifetimes. They share a row
 * and nothing else. Every function here therefore addresses exactly one branch's
 * column set; there is no shared lease column and no shared claim.
 *
 * ELIGIBILITY ASYMMETRY (deliberate, contract C5/C3):
 *   - Branch A is claimable only while the ROW is non-terminal. Once the row is
 *     `applied`, `failed` or `superseded`, a new summary has nowhere to go.
 *   - Branch B ignores the row status entirely. A superseded preparation's late
 *     chunk landing is valid active memory, and post-apply chunk landing is the
 *     explicit design (readiness is branch A; branch B is never blocking). The
 *     only thing that stops branch B is branch B's own terminal state.
 *
 * THE FROZEN TAIL IS NOT A CLAIMABLE ATTEMPT. Once `casFreezeChunksOutput` has
 * persisted the insert-ready snapshot, branch B is in an insert-only phase. That
 * phase is leased through `claimFrozenChunksTail`, which:
 *   - preserves `chunks_status = 'frozen'` (a second worker cannot steal a row
 *     from underneath an in-flight insert — only an EXPIRED lease is takeable);
 *   - never increments `chunks_attempt_count`;
 *   - never routes back to the LLM.
 * That is what keeps "attempt 3 → freeze → crash" retryable forever instead of
 * dying as an exhausted row with a perfectly good snapshot on it.
 *
 * SQL ASSEMBLY. The only variable part of these statements is a column prefix,
 * and it comes from the closed `Branch` union through the frozen record below —
 * never from a caller-supplied string. Nothing else is interpolated.
 */

import { executeWith, getPool, queryOneWith, queryWith, withTransaction } from "../../client.js";
import { pruneCorpusIfFullyTerminal } from "./retention.js";
import { STALE_RECLAIM_BACKOFF_MS } from "./policy.js";
import {
  PREPARATION_COLUMNS,
  mapRow,
  type Branch,
  type CompactionPreparation,
  type CompactionPreparationRow,
} from "./types.js";

interface BranchColumns {
  readonly status: string;
  readonly attemptCount: string;
  readonly maxAttempts: string;
  readonly nextAttemptAt: string;
  readonly lockedAt: string;
  readonly lockedBy: string;
  readonly heartbeatAt: string;
  readonly lastError: string;
}

const BRANCH_COLUMNS: Readonly<Record<Branch, BranchColumns>> = {
  summary: {
    status: "summary_status",
    attemptCount: "summary_attempt_count",
    maxAttempts: "summary_max_attempts",
    nextAttemptAt: "summary_next_attempt_at",
    lockedAt: "summary_locked_at",
    lockedBy: "summary_locked_by",
    heartbeatAt: "summary_heartbeat_at",
    lastError: "summary_last_error",
  },
  chunks: {
    status: "chunks_status",
    attemptCount: "chunks_attempt_count",
    maxAttempts: "chunks_max_attempts",
    nextAttemptAt: "chunks_next_attempt_at",
    lockedAt: "chunks_locked_at",
    lockedBy: "chunks_locked_by",
    heartbeatAt: "chunks_heartbeat_at",
    lastError: "chunks_last_error",
  },
} as const;

/**
 * Branch A cannot run against a row that can no longer use its output. Branch B
 * has no row-status predicate at all — see the header.
 */
const ROW_ELIGIBILITY: Readonly<Record<Branch, string>> = {
  summary: "AND status NOT IN ('applied','failed','superseded')",
  chunks: "",
} as const;

/**
 * Claim the next due LLM attempt for one branch.
 *
 * `SELECT ... FOR UPDATE SKIP LOCKED` inside a transaction, exactly as the
 * compact-jobs outbox does, so two workers polling at the same instant never get
 * the same row for the same branch.
 *
 * SKIP LOCKED takes a ROW lock, not a column-set lock, so two claims for
 * DIFFERENT branches of the same row that land in the same instant do not both
 * succeed — the second one skips the row and returns `null`. That is a claim
 * COLLISION, not a lease conflict: the claim transaction is a two-statement,
 * pure-DB unit of work, and the skipped branch takes the row on its next poll
 * while the other branch is still running. The leases themselves remain fully
 * independent — different columns, different attempt budgets, different
 * heartbeats, different lifetimes — which is the property the design needs.
 *
 * Returns `null` when nothing is due, or when a concurrent claim held the row.
 */
export async function claimBranch(
  branch: Branch,
  workerId: string,
): Promise<CompactionPreparation | null> {
  const c = BRANCH_COLUMNS[branch];
  return withTransaction(async (tx) => {
    const pick = await queryOneWith<{ id: number }>(
      tx,
      `SELECT id FROM compaction_preparations
       WHERE ${c.status} IN ('pending','failed')
         AND ${c.attemptCount} < ${c.maxAttempts}
         AND ${c.nextAttemptAt} <= NOW()
         ${ROW_ELIGIBILITY[branch]}
       ORDER BY created_at ASC, id ASC
       LIMIT 1
       FOR UPDATE SKIP LOCKED`,
    );
    if (!pick) return null;

    const updated = await queryOneWith<CompactionPreparationRow>(
      tx,
      `UPDATE compaction_preparations
       SET ${c.status}       = 'running',
           ${c.lockedAt}     = NOW(),
           ${c.lockedBy}     = $2,
           ${c.heartbeatAt}  = NOW(),
           ${c.attemptCount} = ${c.attemptCount} + 1
       WHERE id = $1
       RETURNING ${PREPARATION_COLUMNS}`,
      [pick.id, workerId],
    );
    return updated ? mapRow(updated) : null;
  });
}

/**
 * Claim the insert-only tail of branch B.
 *
 * Takeable only when the previous holder's lease has expired (or never existed),
 * which is what makes `frozen` non-stealable while an insert is genuinely in
 * flight. The status stays `frozen` and the attempt counter is untouched, so
 * this phase can be resumed any number of times without ever consuming a retry
 * budget that was spent on the model.
 */
export async function claimFrozenChunksTail(
  workerId: string,
  staleThresholdMs: number,
): Promise<CompactionPreparation | null> {
  return withTransaction(async (tx) => {
    const pick = await queryOneWith<{ id: number }>(
      tx,
      `SELECT id FROM compaction_preparations
       WHERE chunks_status = 'frozen'
         AND chunks_next_attempt_at <= NOW()
         AND (chunks_locked_by IS NULL
              OR chunks_heartbeat_at IS NULL
              OR chunks_heartbeat_at < NOW() - ($1::bigint || ' milliseconds')::interval)
       ORDER BY created_at ASC, id ASC
       LIMIT 1
       FOR UPDATE SKIP LOCKED`,
      [staleThresholdMs],
    );
    if (!pick) return null;

    const updated = await queryOneWith<CompactionPreparationRow>(
      tx,
      `UPDATE compaction_preparations
       SET chunks_locked_at    = NOW(),
           chunks_locked_by    = $2,
           chunks_heartbeat_at = NOW()
       WHERE id = $1 AND chunks_status = 'frozen'
       RETURNING ${PREPARATION_COLUMNS}`,
      [pick.id, workerId],
    );
    return updated ? mapRow(updated) : null;
  });
}

/**
 * Owner-checked heartbeat. Returns `false` once the claim is lost — a worker
 * whose row was reclaimed must stop and discard its local state rather than
 * finish into someone else's lease.
 *
 * Accepts both the `running` (LLM) phase and, for branch B, the `frozen`
 * (insert-only) phase: the frozen tail holds a real lease and has to keep it
 * alive for exactly the same reason.
 */
export async function branchHeartbeat(
  id: number,
  branch: Branch,
  workerId: string,
): Promise<boolean> {
  const c = BRANCH_COLUMNS[branch];
  const liveStatuses = branch === "chunks" ? "('running','frozen')" : "('running')";
  const rowCount = await executeWith(
    getPool(),
    `UPDATE compaction_preparations
     SET ${c.heartbeatAt} = NOW()
     WHERE id = $1 AND ${c.status} IN ${liveStatuses} AND ${c.lockedBy} = $2`,
    [id, workerId],
  );
  return rowCount === 1;
}

export interface BranchFailureResult {
  /** `false` when the claim was already lost — nothing was written. */
  ok: boolean;
  /** `true` when this failure exhausted the branch's attempt budget. */
  terminal: boolean;
}

/**
 * Record a failed LLM attempt and schedule the retry, or terminalize when the
 * budget is spent.
 *
 * `{ ok, terminal }` is derived from the guarded `UPDATE ... RETURNING`, not
 * from a pre-read. The legacy compact-jobs version read the row first and
 * computed `terminal` from that snapshot, which is a lost-update window: a
 * concurrent reclaim between the read and the write makes the returned verdict
 * describe a row the caller no longer owns.
 *
 * A branch-A exhaustion also terminalizes the ROW — no summary means no
 * readiness and no cutover, so the preparation is dead. A branch-B exhaustion
 * leaves the row alone: chunks are non-blocking by contract.
 */
export async function casBranchFailed(
  id: number,
  branch: Branch,
  workerId: string,
  error: string,
  nextAttemptInMs: number,
): Promise<BranchFailureResult> {
  const c = BRANCH_COLUMNS[branch];
  return withTransaction(async (tx) => {
    const updated = await queryOneWith<{ status: string }>(
      tx,
      `UPDATE compaction_preparations
       SET ${c.status} = CASE
             WHEN ${c.attemptCount} >= ${c.maxAttempts} THEN 'permanently_failed'
             ELSE 'failed'
           END,
           ${c.lastError}     = $3,
           ${c.nextAttemptAt} = NOW() + ($4::bigint || ' milliseconds')::interval,
           ${c.lockedAt}      = NULL,
           ${c.lockedBy}      = NULL,
           ${c.heartbeatAt}   = NULL
       WHERE id = $1 AND ${c.status} = 'running' AND ${c.lockedBy} = $2
       RETURNING ${c.status} AS status`,
      [id, workerId, error, nextAttemptInMs],
    );
    if (!updated) return { ok: false, terminal: false };

    const terminal = updated.status === "permanently_failed";
    if (!terminal) return { ok: true, terminal: false };

    if (branch === "summary") {
      await executeWith(
        tx,
        `UPDATE compaction_preparations
         SET status       = 'failed',
             last_error   = $2,
             completed_at = NOW()
         WHERE id = $1 AND status IN ('preparing','summary_ready')`,
        [id, error],
      );
    }
    // Terminal on either branch can be the second of the two retention
    // crossings — the row may already have been terminal for a long time.
    await pruneCorpusIfFullyTerminal(tx, id);
    return { ok: true, terminal: true };
  });
}

/**
 * Record a failed insert-only tail attempt.
 *
 * Distinct from `casBranchFailed` on purpose: the snapshot is already durable,
 * so this failure must NOT burn an LLM attempt and must NOT leave `frozen`.
 * The row goes back to an unleased `frozen` with a backoff and is picked up
 * again by `claimFrozenChunksTail`. There is no terminal outcome here — an
 * insert that cannot land is retried until it does.
 */
export async function casFrozenTailFailed(
  id: number,
  workerId: string,
  error: string,
  nextAttemptInMs: number,
): Promise<boolean> {
  const rowCount = await executeWith(
    getPool(),
    `UPDATE compaction_preparations
     SET chunks_last_error      = $3,
         chunks_next_attempt_at = NOW() + ($4::bigint || ' milliseconds')::interval,
         chunks_locked_at       = NULL,
         chunks_locked_by       = NULL,
         chunks_heartbeat_at    = NULL
     WHERE id = $1 AND chunks_status = 'frozen' AND chunks_locked_by = $2`,
    [id, workerId, error, nextAttemptInMs],
  );
  return rowCount === 1;
}

/**
 * Worker bootstrap sweep: reclaim branch leases whose heartbeat aged out.
 *
 * The reset MUST respect the attempt budget. The legacy compact-jobs sweep
 * unconditionally returned stale rows to `pending`, which produced rows that
 * were pending forever and unclaimable forever, because the claim predicate also
 * requires `attempt_count < max_attempts`. Here an exhausted stale row goes
 * straight to `permanently_failed` — visible, terminal, and swept by the same
 * downstream handling as any other exhaustion.
 *
 * The frozen tail is deliberately NOT swept: its lease expiry is already the
 * claim condition in `claimFrozenChunksTail`, so a dead holder is picked up
 * without any status rewrite.
 *
 * Returns the number of rows reclaimed.
 */
export async function recoverStaleBranch(
  branch: Branch,
  staleThresholdMs: number,
): Promise<number> {
  const c = BRANCH_COLUMNS[branch];
  return withTransaction(async (tx) => {
    const reclaimed = await queryWith<{ id: number; status: string }>(
      tx,
      `UPDATE compaction_preparations
       SET ${c.status} = CASE
             WHEN ${c.attemptCount} >= ${c.maxAttempts} THEN 'permanently_failed'
             ELSE 'pending'
           END,
           ${c.lockedAt}      = NULL,
           ${c.lockedBy}      = NULL,
           ${c.heartbeatAt}   = NULL,
           ${c.nextAttemptAt} = NOW() + ($2::bigint || ' milliseconds')::interval
       WHERE ${c.status} = 'running'
         AND (${c.heartbeatAt} IS NULL
              OR ${c.heartbeatAt} < NOW() - ($1::bigint || ' milliseconds')::interval)
       RETURNING id, ${c.status} AS status`,
      [staleThresholdMs, Math.min(staleThresholdMs, STALE_RECLAIM_BACKOFF_MS)],
    );

    for (const row of reclaimed) {
      if (row.status !== "permanently_failed") continue;
      if (branch === "summary") {
        await executeWith(
          tx,
          `UPDATE compaction_preparations
           SET status       = 'failed',
               last_error   = 'branch_summary_stale_exhausted',
               completed_at = NOW()
           WHERE id = $1 AND status IN ('preparing','summary_ready')`,
          [row.id],
        );
      }
      await pruneCorpusIfFullyTerminal(tx, row.id);
    }
    return reclaimed.length;
  });
}
