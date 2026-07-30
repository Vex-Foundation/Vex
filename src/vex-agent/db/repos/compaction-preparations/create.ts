/**
 * Compaction-preparations — fork-time insert and the supersede-then-replace
 * sequence.
 *
 * LOCKING CONTRACT. Both functions REQUIRE a caller-supplied `PoolClient` that
 * already holds `SELECT ... FROM sessions WHERE id = $1 FOR UPDATE`, taken by
 * the capture path exactly as `engine/compact-jobs/service.ts` does. They never
 * take a session lock themselves: the apply path locks
 * `session advisory lock → sessions row → preparation row`, and a fork that
 * grabbed the preparation row first would deadlock against it.
 *
 * The corpus fingerprint is computed by the corpus builder and passed in. This
 * module stores it verbatim and never recomputes it — recomputing here would
 * mean two implementations of "the canonical bytes", which is exactly the drift
 * the fingerprint exists to detect.
 */

import type { PoolClient } from "pg";

import { executeWith, queryOneWith, queryWith } from "../../client.js";
import { pruneCorpusIfFullyTerminal } from "./retention.js";
import {
  PREPARATION_COLUMNS,
  mapRow,
  type CompactionPreparation,
  type CompactionPreparationRow,
  type NewCompactionPreparation,
} from "./types.js";

const INSERT_SQL = `
  INSERT INTO compaction_preparations (
    session_id,
    watermark_message_id, base_checkpoint_generation, target_checkpoint_generation,
    frozen_session_summary,
    corpus_text, corpus_sha256, corpus_format_version,
    corpus_message_count, corpus_bytes, corpus_redaction_hard, corpus_redaction_mask
  )
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
  ON CONFLICT (session_id)
    WHERE status IN ('preparing','summary_ready','apply_requested','applying')
  DO NOTHING
  RETURNING ${PREPARATION_COLUMNS}
`;

function insertParams(input: NewCompactionPreparation): unknown[] {
  return [
    input.sessionId,
    input.watermarkMessageId,
    input.baseCheckpointGeneration,
    input.targetCheckpointGeneration,
    input.frozenSessionSummary,
    input.corpusText,
    input.corpusSha256,
    input.corpusFormatVersion,
    input.corpusMessageCount,
    input.corpusBytes,
    input.corpusRedactionHard,
    input.corpusRedactionMask,
  ];
}

export type CreatePreparationResult =
  | { ok: true; preparation: CompactionPreparation }
  | { ok: false; reason: "live_exists" };

/**
 * Insert a preparation at fork time.
 *
 * The one-live-per-session guarantee is enforced by the partial unique index
 * `uniq_cprep_live_per_session`, and the conflict is INFERRED from that index's
 * predicate rather than caught as a `23505` error. That distinction matters: a
 * unique violation aborts the surrounding transaction, so a caller that forks
 * inside the capture transaction (which is every caller) would have to roll back
 * and redo the whole session-locked read just to learn "someone else already
 * has a live preparation". `DO NOTHING` reports the same fact with the
 * transaction still usable.
 *
 * The index predicate is repeated verbatim in the SQL above; it and the
 * migration must stay identical or Postgres cannot match the arbiter.
 */
export async function createPreparation(
  input: NewCompactionPreparation,
  client: PoolClient,
): Promise<CreatePreparationResult> {
  const row = await queryOneWith<CompactionPreparationRow>(
    client,
    INSERT_SQL,
    insertParams(input),
  );
  if (!row) return { ok: false, reason: "live_exists" };
  return { ok: true, preparation: mapRow(row) };
}

export type SupersedeAndReplaceResult =
  | { ok: true; superseded: CompactionPreparation; replacement: CompactionPreparation }
  | { ok: false; reason: "not_found" | "apply_in_progress" | "not_live" };

/**
 * Supersede a live preparation and insert its replacement, in one transaction.
 *
 * ORDER IS FORCED BY THE SCHEMA, not by preference. The replacement's id does
 * not exist until it is inserted, and the old row cannot stay in the partial
 * unique while the new one is inserted. So the only sequence that satisfies both
 * is: mark the old row `superseded` with a NULL link → insert the replacement →
 * fill the link with a guarded update. All three commit together, so an observer
 * never sees two live rows and never sees a permanently unlinked chain.
 *
 * Superseding `apply_requested` or `applying` is REFUSED (C3): once a cutover is
 * requested it must either apply or terminalize. The refusal is reported as
 * `apply_in_progress` so the trigger can leave the row alone rather than retry.
 *
 * The superseded row keeps its `chunks_*` state untouched — a late branch-B
 * landing on it is valid active memory — which is also why the corpus prune is
 * attempted here and is a no-op unless branch B already finished.
 */
export async function supersedeAndReplace(
  previousId: number,
  input: NewCompactionPreparation,
  client: PoolClient,
): Promise<SupersedeAndReplaceResult> {
  const supersededRows = await queryWith<{ id: number }>(
    client,
    `UPDATE compaction_preparations
     SET status       = 'superseded',
         completed_at = NOW()
     WHERE id = $1
       AND status IN ('preparing','summary_ready')
     RETURNING id`,
    [previousId],
  );

  if (supersededRows.length === 0) {
    const current = await queryOneWith<{ status: string }>(
      client,
      "SELECT status FROM compaction_preparations WHERE id = $1",
      [previousId],
    );
    if (!current) return { ok: false, reason: "not_found" };
    return current.status === "apply_requested" || current.status === "applying"
      ? { ok: false, reason: "apply_in_progress" }
      : { ok: false, reason: "not_live" };
  }

  const replacementRow = await queryOneWith<CompactionPreparationRow>(
    client,
    INSERT_SQL,
    insertParams(input),
  );
  if (!replacementRow) {
    // The old row just left the partial unique inside this very transaction, so
    // the only way the insert can still conflict is a second live row for the
    // same session — which the index forbids. Fail loudly rather than commit a
    // supersession with no successor.
    throw new Error(
      `supersedeAndReplace: replacement insert conflicted after superseding id=${previousId} ` +
        `(session=${input.sessionId}) — one-live-per-session invariant violated`,
    );
  }

  await executeWith(
    client,
    `UPDATE compaction_preparations
     SET superseded_by_id = $2
     WHERE id = $1 AND status = 'superseded' AND superseded_by_id IS NULL`,
    [previousId, replacementRow.id],
  );

  await pruneCorpusIfFullyTerminal(client, previousId);

  const superseded = await queryOneWith<CompactionPreparationRow>(
    client,
    `SELECT ${PREPARATION_COLUMNS} FROM compaction_preparations WHERE id = $1`,
    [previousId],
  );
  if (!superseded) {
    throw new Error(`supersedeAndReplace: superseded row id=${previousId} vanished mid-transaction`);
  }

  return {
    ok: true,
    superseded: mapRow(superseded),
    replacement: mapRow(replacementRow),
  };
}
