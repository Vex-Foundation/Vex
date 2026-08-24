/**
 * Session-memories recall — top-K cosine retrieval scoped to a single session.
 *
 * Cross-session recall is intentionally NOT supported: memories represent
 * per-session narrative and would degrade quickly if mixed across missions.
 * For cross-session durable facts, the agent uses `MemorySearch` instead.
 *
 * The model+dim filter is MANDATORY (mixed-dim `<=>` crashes pgvector and
 * cross-model similarity is meaningless).
 */

import { query } from "../../client.js";
import { vectorLiteral } from "../knowledge/types.js";
import {
  MEMORY_COLUMNS,
  mapRow,
  type RecallFilters,
  type RecallHit,
  type SessionMemoryRecallRow,
} from "./types.js";

export async function recallTopK(
  queryEmbedding: readonly number[],
  filters: RecallFilters,
): Promise<RecallHit[]> {
  if (filters.topK <= 0) return [];
  if (queryEmbedding.length !== filters.embeddingDim) {
    throw new Error(
      `session-memories recallTopK: query embedding length ${queryEmbedding.length} ` +
        `does not match filter dim ${filters.embeddingDim}`,
    );
  }

  const rows = await query<SessionMemoryRecallRow>(
    `SELECT
       ${MEMORY_COLUMNS},
       (embedding <=> $1::vector) AS cosine_distance
     FROM session_memories
     WHERE session_id      = $2
       AND status          = 'active'
       AND embedding_model = $3
       AND embedding_dim   = $4
     ORDER BY embedding <=> $1::vector
     LIMIT $5`,
    [
      vectorLiteral(queryEmbedding),
      filters.sessionId,
      filters.embeddingModel,
      filters.embeddingDim,
      filters.topK,
    ],
  );

  const minSim = filters.minSimilarity ?? 0;
  const hits: RecallHit[] = [];
  for (const r of rows) {
    const similarity = clampUnit(1 - r.cosine_distance);
    if (similarity < minSim) continue;
    hits.push({ memory: mapRow(r), similarity });
  }
  return hits;
}

function clampUnit(x: number): number {
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}
