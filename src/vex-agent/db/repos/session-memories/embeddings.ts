/**
 * Session-memories — maintenance: re-embed after body_md change.
 */

import { execute } from "../../client.js";
import { vectorLiteral } from "../knowledge/types.js";

/**
 * Update only the embedding columns. Used by the resolution path once the
 * caller has produced a fresh embedding for the new body. Body_md is NOT
 * updated here; call `markOutstandingResolved` first.
 *
 * Race-safety: the UPDATE is conditional on `body_md_hash = $expectedHash`.
 * The caller passes the hash of the body the embedding was computed against
 * (`result.memory.bodyMdHash` from the same `markOutstandingResolved` call).
 * If a concurrent resolution rewrote `body_md` (and bumped its hash) between
 * the embed call and this UPDATE, the WHERE clause excludes the row and the
 * function returns `false` — the embedding was computed against a body that
 * is no longer current, so writing it would leave a stale vector on a fresh
 * body. The losing caller logs `SessionMemoryResolve.embed_stale`; the
 * winning caller's embedding lands. (codex PR2 round-3 P2 / PR3-final race fix.)
 */
export async function updateEmbedding(
  memoryId: number,
  embedding: number[],
  embeddingModel: string,
  embeddingDim: number,
  expectedBodyMdHash: string,
): Promise<boolean> {
  if (embedding.length !== embeddingDim) {
    throw new Error(
      `updateEmbedding: length ${embedding.length} ≠ dim ${embeddingDim} (memoryId=${memoryId})`,
    );
  }
  const rowCount = await execute(
    `UPDATE session_memories
     SET embedding       = $2::vector,
         embedding_model = $3,
         embedding_dim   = $4,
         updated_at      = NOW()
     WHERE id = $1 AND body_md_hash = $5`,
    [memoryId, vectorLiteral(embedding), embeddingModel, embeddingDim, expectedBodyMdHash],
  );
  return rowCount === 1;
}
