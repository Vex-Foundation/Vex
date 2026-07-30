/**
 * Compaction-preparations — branch outcome transitions, plus row failure.
 *
 * One guarded `UPDATE` per FSM edge. Every guard is owner-checked against the
 * branch lease, so a worker whose row was reclaimed while it was talking to the
 * provider cannot land its result on top of the new owner's work. `ok: false`
 * always means "nothing was written"; callers treat it as a lost claim and
 * discard their local state.
 *
 * The apply-side edges live in `apply-transitions.ts` — they answer to a
 * different lease (the runner's) and a different lock order.
 */

import type { PoolClient } from "pg";

import { executeWith, getPool, withTransaction } from "../../client.js";
import { jsonb } from "../../params.js";
import { MAX_SUMMARY_CHARS } from "./policy.js";
import { pruneCorpusIfFullyTerminal } from "./retention.js";
import { withScope } from "./transaction-scope.js";
import type { FrozenChunksOutput } from "./frozen-output-schema.js";

export interface SummaryReadyInput {
  summary: string;
  promptVersion: string;
  provider: string;
  model: string;
  costUsd: number | null;
}

export type SummaryReadyResult =
  | { ok: true }
  | { ok: false; reason: "summary_out_of_bounds" | "claim_lost" };

/**
 * Branch A succeeded: store the summary and flip the row to `summary_ready`.
 *
 * This is the readiness edge — everything downstream (the apply button, the
 * agent-visible apply tool, forced critical apply) becomes possible the moment
 * it commits, so the branch and row transitions are ONE statement. A two-step
 * version could publish readiness with no summary attached, and the
 * `cprep_ready_requires_summary` CHECK exists to make that unrepresentable.
 *
 * The length bound is enforced before any SQL is issued. Branch A already
 * validates, redacts and bounds its own output; this is the storage-side
 * backstop, because the value lands in `sessions.summary` at cutover and is then
 * re-sent on every subsequent inference — an unbounded one is a permanent,
 * per-turn context cost.
 */
export async function casSummaryReady(
  id: number,
  workerId: string,
  input: SummaryReadyInput,
): Promise<SummaryReadyResult> {
  const summary = input.summary.trim();
  if (summary.length === 0 || summary.length > MAX_SUMMARY_CHARS) {
    return { ok: false, reason: "summary_out_of_bounds" };
  }

  const rowCount = await executeWith(
    getPool(),
    `UPDATE compaction_preparations
     SET status                 = 'summary_ready',
         summary_status         = 'succeeded',
         summary_output         = $3,
         summary_prompt_version = $4,
         summary_provider       = $5,
         summary_model          = $6,
         summary_cost_usd       = $7,
         summary_completed_at   = NOW(),
         summary_locked_at      = NULL,
         summary_locked_by      = NULL,
         summary_heartbeat_at   = NULL
     WHERE id = $1
       AND status = 'preparing'
       AND summary_status = 'running'
       AND summary_locked_by = $2`,
    [
      id,
      workerId,
      summary,
      input.promptVersion,
      input.provider,
      input.model,
      input.costUsd,
    ],
  );
  return rowCount === 1 ? { ok: true } : { ok: false, reason: "claim_lost" };
}

export interface FreezeChunksInput {
  frozenOutput: FrozenChunksOutput;
  frozenOutputSha256: string;
  /**
   * What Branch B DISCARDED while building this snapshot — chunks dropped for
   * carrying live state, and chunks dropped by output-side redaction. Recorded
   * at freeze because that is where the rejection happens; the insert phase
   * rejects nothing. Successor of `compact_jobs.chunks_rejected_by_*`.
   */
  rejectedByExclusion: number;
  rejectedByRedaction: number;
  provider: string;
  model: string;
  costUsd: number | null;
}

/**
 * THE C5 BARRIER. Persist the complete insert-ready snapshot before a single
 * `session_memories` row is written.
 *
 * `chunks_frozen_output IS NULL` is part of the guard, so the snapshot is
 * write-once: a retry that somehow re-reaches this edge cannot overwrite the
 * bytes an earlier attempt already committed and a later insert may already have
 * partially landed. A `false` return therefore means either the claim was lost
 * or the snapshot already exists — in both cases the caller must re-read the row
 * rather than insert its own version.
 *
 * The freeze-time rejection counters are written HERE, in the same statement,
 * so the snapshot and the account of what was dropped to produce it can never
 * disagree.
 *
 * Callers MUST NOT insert any memory row until this resolves `true`.
 */
export async function casFreezeChunksOutput(
  id: number,
  workerId: string,
  input: FreezeChunksInput,
): Promise<boolean> {
  const rowCount = await executeWith(
    getPool(),
    `UPDATE compaction_preparations
     SET chunks_status              = 'frozen',
         chunks_frozen_output       = $3::jsonb,
         chunks_frozen_output_sha256 = $4,
         chunks_frozen_at           = NOW(),
         chunks_rejected_by_exclusion_at_freeze = $5,
         chunks_rejected_by_redaction_at_freeze = $6,
         chunks_provider            = $7,
         chunks_model               = $8,
         chunks_cost_usd            = $9
     WHERE id = $1
       AND chunks_status = 'running'
       AND chunks_locked_by = $2
       AND chunks_frozen_output IS NULL`,
    [
      id,
      workerId,
      jsonb(input.frozenOutput),
      input.frozenOutputSha256,
      input.rejectedByExclusion,
      input.rejectedByRedaction,
      input.provider,
      input.model,
      input.costUsd,
    ],
  );
  return rowCount === 1;
}

/**
 * INSERT-phase outcome only. There is no rejection count here: everything in the
 * snapshot was validated and redacted before freezing, so the only chunk that
 * fails to become a new row is one the `(session_id, content_hash)` active-row
 * upsert collapsed onto an identical existing memory. Freeze-time rejections
 * live on `FreezeChunksInput`.
 */
export interface ChunksLandedCounts {
  /** Rows the upsert actually inserted. */
  inserted: number;
  /** Rows the active-row upsert deduped away. */
  deduped: number;
}

/**
 * Branch B finished landing the frozen snapshot.
 *
 * `chunks_landed_after_supersession` is derived in SQL from the row's own status
 * rather than passed in by the caller: the row may have been superseded at any
 * moment while the insert was running, and a caller-computed flag would record
 * what was true when the worker started, not when it committed.
 *
 * This is one of the two retention crossings — branch B may well be the last
 * consumer to finish, long after the row itself terminalized.
 */
export async function casChunksApplied(
  id: number,
  workerId: string,
  counts: ChunksLandedCounts,
): Promise<boolean> {
  return withTransaction(async (tx) => {
    const rowCount = await executeWith(
      tx,
      `UPDATE compaction_preparations
       SET chunks_status                    = 'succeeded',
           chunks_inserted                  = $3,
           chunks_deduped                   = $4,
           chunks_landed_after_supersession = (status = 'superseded'),
           chunks_completed_at              = NOW(),
           chunks_locked_at                 = NULL,
           chunks_locked_by                 = NULL,
           chunks_heartbeat_at              = NULL
       WHERE id = $1
         AND chunks_status = 'frozen'
         AND chunks_locked_by = $2`,
      [id, workerId, counts.inserted, counts.deduped],
    );
    if (rowCount !== 1) return false;
    await pruneCorpusIfFullyTerminal(tx, id);
    return true;
  });
}

/**
 * Terminalize a preparation that has not reached the apply path.
 *
 * Guarded on the pre-apply statuses only: once a cutover is requested the row is
 * owned by the apply lease and is terminalized through `casFailApply`, which
 * carries the runner-lease guard this edge deliberately lacks.
 *
 * Terminal ⇒ retention crossing.
 */
export async function casMarkFailed(
  id: number,
  error: string,
  client?: PoolClient,
): Promise<boolean> {
  return withScope(client, async (tx) => {
    const rowCount = await executeWith(
      tx,
      `UPDATE compaction_preparations
       SET status       = 'failed',
           last_error   = $2,
           completed_at = NOW()
       WHERE id = $1 AND status IN ('preparing','summary_ready')`,
      [id, error],
    );
    if (rowCount !== 1) return false;
    await pruneCorpusIfFullyTerminal(tx, id);
    return true;
  });
}
