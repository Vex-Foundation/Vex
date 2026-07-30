/**
 * Compaction-preparations — engine-side reads.
 *
 * These return the full `CompactionPreparation`: the workers and the cutover
 * legitimately need the corpus and the summary.
 *
 * There is deliberately NO renderer-facing projection here. The desktop app
 * reads preparations through its own app-scoped query in the main process,
 * because the scoping this module would need (`scope='vex_app'`) is not
 * something an engine repo can enforce. A bounded projection living here would
 * be a second, unenforceable read path with no consumer.
 */

import { query, queryOne } from "../../client.js";
import type { FrozenChunksOutput } from "./frozen-output-schema.js";
import {
  PREPARATION_COLUMNS,
  mapRow,
  type CompactionPreparation,
  type CompactionPreparationRow,
} from "./types.js";

export async function getPreparationById(
  id: number,
): Promise<CompactionPreparation | null> {
  const row = await queryOne<CompactionPreparationRow>(
    `SELECT ${PREPARATION_COLUMNS} FROM compaction_preparations WHERE id = $1`,
    [id],
  );
  return row ? mapRow(row) : null;
}

/**
 * The single row occupying the one-live-per-session partial unique, if any.
 * The predicate is the index predicate verbatim.
 */
export async function getLivePreparationForSession(
  sessionId: string,
): Promise<CompactionPreparation | null> {
  const row = await queryOne<CompactionPreparationRow>(
    `SELECT ${PREPARATION_COLUMNS}
     FROM compaction_preparations
     WHERE session_id = $1
       AND status IN ('preparing','summary_ready','apply_requested','applying')`,
    [sessionId],
  );
  return row ? mapRow(row) : null;
}

export async function listPreparationsForSession(
  sessionId: string,
  limit: number,
): Promise<CompactionPreparation[]> {
  const rows = await query<CompactionPreparationRow>(
    `SELECT ${PREPARATION_COLUMNS}
     FROM compaction_preparations
     WHERE session_id = $1
     ORDER BY created_at DESC, id DESC
     LIMIT $2`,
    [sessionId, limit],
  );
  return rows.map(mapRow);
}

/**
 * The frozen snapshot for the insert-only retry path. Returns `null` when the
 * row is gone or has not been frozen yet; the JSONB is validated by `mapRow`'s
 * boundary parse, so a snapshot written by an incompatible build throws here
 * rather than reaching the memory insert.
 */
export async function getFrozenChunksOutput(
  id: number,
): Promise<FrozenChunksOutput | null> {
  const preparation = await getPreparationById(id);
  return preparation?.chunksFrozenOutput ?? null;
}
