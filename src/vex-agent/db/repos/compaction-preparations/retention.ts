/**
 * Compaction-preparations retention — corpus pruning.
 *
 * Every preparation stores a full copy of the conversation prefix it was forked
 * from. Left alone that is unbounded local disk growth: one transcript copy per
 * preparation, per session, forever.
 *
 * The corpus can be dropped once nothing can read it again. Two independent
 * consumers exist, and BOTH must be finished:
 *   - the ROW itself, whose apply path reads the corpus only while non-terminal;
 *   - BRANCH B, which is explicitly allowed to keep working — and to land memory
 *     rows — after the row reached `applied` or `superseded` (contract C5/C3).
 *
 * Either one can be the last to finish, so the prune is attempted at BOTH
 * crossings, inside the SAME transaction as the transition that caused it:
 *   - the row becomes terminal while branch B is already terminal;
 *   - branch B becomes terminal while the row is already terminal.
 * The guard below is the same in both cases, so the caller never has to know
 * which crossing it is; whichever transition happens second is the one that
 * prunes. Running it at a crossing that is not the second one is a no-op.
 *
 * Only `corpus_text` is nulled. Fingerprint, format version, counts and every
 * audit column survive, so a pruned row is still fully explainable — and
 * `corpus_pruned_at` distinguishes "pruned" from "never had one", which the
 * `cprep_corpus_present_unless_pruned` CHECK relies on.
 */

import type { PoolClient } from "pg";

import { executeWith } from "../../client.js";

/**
 * Prune the corpus if — and only if — both the row and branch B are terminal.
 *
 * MUST be called with the transaction client of the transition that may have
 * just made the second crossing, so the prune commits atomically with it. A
 * separate transaction could observe a torn state and prune a corpus a
 * concurrent branch-B retry is about to read.
 *
 * Returns `true` when this call actually pruned (useful for telemetry and for
 * asserting the crossing in tests); `false` means the row was not yet fully
 * terminal, or the corpus was already pruned.
 */
export async function pruneCorpusIfFullyTerminal(
  client: PoolClient,
  id: number,
): Promise<boolean> {
  const rowCount = await executeWith(
    client,
    `UPDATE compaction_preparations
     SET corpus_text     = NULL,
         corpus_pruned_at = NOW()
     WHERE id = $1
       AND corpus_text IS NOT NULL
       AND status IN ('applied','failed','superseded')
       AND chunks_status IN ('succeeded','permanently_failed')`,
    [id],
  );
  return rowCount === 1;
}
