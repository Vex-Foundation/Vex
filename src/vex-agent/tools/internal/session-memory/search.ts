/**
 * `session_memory_search` tool handler — semantic recall over THIS session's
 * narrative memory chunks (`session_memories` table).
 *
 * Returns top-K narrative chunks (4-section markdown bodies) scoped to the
 * caller's session_id. Embedding goes through the same local EmbeddingGemma
 * service as `long_memory_search` (no remote calls, no OpenRouter).
 *
 * Empty-store short-circuit: if the session has zero active chunks, returns
 * success with an empty hits array and a hint — no DB load, no embedding
 * call. The memory-state banner in the system prompt is the primary signal
 * to the agent; this handler is the runtime backstop.
 */

import { z } from "zod";

import type { ToolResult } from "../../types.js";
import type { InternalToolContext } from "../types.js";
import {
  getSessionMemoryStats,
  recallTopK,
} from "@vex-agent/db/repos/session-memories/index.js";
import { embedQuery } from "@vex-agent/embeddings/client.js";
import {
  clampMemoryRecallK,
  MEMORY_BANNER_RECENT_THEMES_LIMIT,
  MEMORY_RECALL_DEFAULT_K,
  MEMORY_RECALL_MIN_SIMILARITY,
} from "@vex-agent/memory/session-memory-policy.js";
import logger from "@utils/logger.js";
import { formatZodIssueForModel } from "../arg-validation.js";

const SessionMemorySearchSchema = z.object({
  query: z
    .string()
    .min(1)
    .max(2000)
    .describe(
      "Semantic intent. Write the way you would ask another expert — not keywords. ✓ 'previous WIF position decisions and rationale' ✗ 'WIF'",
    ),
  k: z.number().int().positive().optional().describe(
    `Max chunks to return. Default ${MEMORY_RECALL_DEFAULT_K}, clamped to 5.`,
  ),
});

export async function handleSessionMemorySearch(
  args: unknown,
  context: InternalToolContext,
): Promise<ToolResult> {
  const parsed = SessionMemorySearchSchema.safeParse(args);
  if (!parsed.success) {
    return {
      success: false,
      output: `session_memory_search: ${formatZodIssueForModel(parsed.error.issues[0], args)}`,
    };
  }
  const { query, k } = parsed.data;
  const topK = clampMemoryRecallK(k);

  logger.info("session_memory_search.called", {
    sessionId: context.sessionId,
    queryLen: query.length,
    k: topK,
  });

  // Empty-store short-circuit. Stats query is one round-trip; cheaper than
  // an embedding call when the session has nothing recallable yet.
  const stats = await getSessionMemoryStats(
    context.sessionId,
    MEMORY_BANNER_RECENT_THEMES_LIMIT,
  );
  if (stats.activeCount === 0) {
    logger.info("session_memory_search.empty_store", {
      sessionId: context.sessionId,
    });
    return {
      success: true,
      output:
        "session_memory_search: no memories yet — the session has not been compacted. " +
        "Continue working; memories become available after the first compact (≥ 88% context).",
      data: { hits: [], reason: "empty_store" },
    };
  }

  const queryEmbedding = await embedQuery(query);

  const hits = await recallTopK(queryEmbedding.embedding, {
    sessionId: context.sessionId,
    embeddingModel: queryEmbedding.providerModel,
    embeddingDim: queryEmbedding.embedding.length,
    topK,
    minSimilarity: MEMORY_RECALL_MIN_SIMILARITY,
  });

  logger.info("session_memory_search.completed", {
    sessionId: context.sessionId,
    queryLen: query.length,
    hits: hits.length,
    activeCount: stats.activeCount,
  });

  if (hits.length === 0) {
    return {
      success: true,
      output:
        `session_memory_search: no chunks above similarity threshold ${MEMORY_RECALL_MIN_SIMILARITY}. ` +
        `Session has ${stats.activeCount} chunk(s) across ${stats.compactCount} compact(s); try a different framing.`,
      data: { hits: [], reason: "below_threshold", active_count: stats.activeCount },
    };
  }

  return {
    success: true,
    output: hits
      .map((h, i) => {
        const unresolved = h.memory.outstandingItems.filter((it) => it.resolvedAt === null).length;
        const unresolvedHint = unresolved > 0 ? ` [${unresolved} unresolved outstanding]` : "";
        return [
          `── chunk ${i + 1} of ${hits.length} (theme: ${h.memory.theme}, sim: ${h.similarity.toFixed(3)}, gen: ${h.memory.checkpointGeneration})${unresolvedHint} ──`,
          h.memory.bodyMd,
        ].join("\n");
      })
      .join("\n\n"),
    data: {
      hits: hits.map((h) => ({
        id: h.memory.id,
        theme: h.memory.theme,
        similarity: h.similarity,
        generation: h.memory.checkpointGeneration,
        body_md: h.memory.bodyMd,
        outstanding_unresolved_count: h.memory.outstandingItems.filter((it) => it.resolvedAt === null)
          .length,
      })),
      active_count: stats.activeCount,
      compact_count: stats.compactCount,
    },
  };
}
