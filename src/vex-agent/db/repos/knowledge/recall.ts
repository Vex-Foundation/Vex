/**
 * Knowledge repo — vector recall (top-K cosine over pgvector).
 *
 * The model+dim filter is mandatory because the column type has no typmod —
 * running `<=>` against rows produced by a different-dim model crashes pgvector.
 * The filter is also semantic: comparing similarities across different model
 * spaces is meaningless.
 */

import { query } from "../../client.js";
import {
  type KnowledgeRecallRow,
  type LongMemoryRecallCandidate,
  type RecallFilters,
  mapRowToLongMemoryCandidate,
  vectorLiteral,
} from "./types.js";

/**
 * Top-K cosine recall over `knowledge_entries` (S3) — active/model/dim/expiry
 * vector recall whose SELECT/DTO ALSO returns `source` (provenance tier) and
 * `maturity_state` so `MemorySearch` can rank inferred/hypothesis entries
 * LOWER without excluding them (genesis §951).
 *
 * Fetches `k * 2` raw candidates as headroom; the caller reranks + de-weights
 * before capping inline.
 */
export async function recallLongMemoryTopK(
  queryEmbedding: readonly number[],
  filters: RecallFilters,
  k: number,
): Promise<LongMemoryRecallCandidate[]> {
  if (k <= 0) return [];
  if (queryEmbedding.length !== filters.embeddingDim) {
    throw new Error(
      `recallLongMemoryTopK: query embedding length ${queryEmbedding.length} does not match filter dim ${filters.embeddingDim}`,
    );
  }

  // S3 always returns active + non-expired (no `scope` param — R1-#5). The
  // `includeExpired` filter still defaults true for parity, but the handler
  // passes `includeExpired:false`.
  const includeExpired = filters.includeExpired !== false;
  const params: unknown[] = [
    vectorLiteral(queryEmbedding),
    filters.embeddingModel,
    filters.embeddingDim,
  ];
  let whereExtra = "";

  if (filters.kind) {
    params.push(filters.kind);
    whereExtra += ` AND kind = $${params.length}`;
  }
  if (!includeExpired) {
    whereExtra += " AND (pinned = TRUE OR valid_until IS NULL OR valid_until > now())";
  }

  params.push(k * 2);
  const limitParam = `$${params.length}`;

  const rows = await query<KnowledgeRecallRow>(
    `SELECT
       id, kind, title, summary, content_md, tags, source_refs,
       confidence, status, pinned, valid_from, valid_until,
       content_hash, embedding_model, embedding_dim, source, maturity_state,
       activation_strength,
       created_at, updated_at,
       (embedding <=> $1::vector) AS cosine_distance
     FROM knowledge_entries
     WHERE status = 'active'
       AND embedding_model = $2
       AND embedding_dim = $3
       ${whereExtra}
     ORDER BY embedding <=> $1::vector
     LIMIT ${limitParam}`,
    params,
  );

  return rows.map(mapRowToLongMemoryCandidate);
}
