/**
 * `MemorySearch` embedding + dual-store recall (steps 2–4 of the
 * handler, split out in 0R.15, refactor-only). Fail-loud: there is no
 * non-embedded fallback, and both stores are recalled under the SAME
 * provider/dimension filter that wrote them (write/read consistency).
 */

import { recallLongMemoryTopK } from "@vex-agent/db/repos/knowledge.js";
import { recallCandidatesTopK } from "@vex-agent/db/repos/memory-candidates/index.js";
import { embedQuery } from "@vex-agent/embeddings/client.js";
import { loadEmbeddingConfig } from "@vex-agent/embeddings/config.js";
import { scoreRecallCandidate } from "@vex-agent/knowledge/ranking.js";
import { memLog } from "@vex-agent/memory/observability/logger.js";
import type {
  LongMemoryKnowledgeResult,
  LongMemoryCandidateResult,
} from "@vex-agent/memory/long-memory-retrieval-policy.js";
import type { LongMemorySearchInput } from "@vex-agent/memory/schema/long-memory-search.js";

import type { ToolResult } from "../../../types.js";
import { fail } from "../../types.js";

export interface LongMemoryRecall {
  readonly ok: true;
  readonly knowledgeResults: Omit<LongMemoryKnowledgeResult, "score">[];
  readonly candidateResults: Omit<LongMemoryCandidateResult, "score">[];
}

export type LongMemoryRecallOutcome =
  | LongMemoryRecall
  | { readonly ok: false; readonly result: ToolResult };

export async function recallLongMemory(
  input: LongMemorySearchInput,
): Promise<LongMemoryRecallOutcome> {
  // 2. Embed (fail-loud — no non-embedded fallback).
  let config;
  try {
    config = loadEmbeddingConfig();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, result: fail(`embedding config invalid: ${msg}`) };
  }

  let embedding: number[];
  let providerModel: string;
  try {
    const result = await embedQuery(input.query, config);
    embedding = result.embedding;
    providerModel = result.providerModel;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, result: fail(`embedding service unavailable: ${msg}`) };
  }

  // 3 + 4. Recall both stores under the SAME provider/dim filter.
  const now = new Date();
  let knowledgeResults: Omit<LongMemoryKnowledgeResult, "score">[];
  let candidateResults: Omit<LongMemoryCandidateResult, "score">[];
  try {
    const knowledge = await recallLongMemoryTopK(
      embedding,
      {
        embeddingModel: providerModel,
        embeddingDim: embedding.length,
        kind: input.kind,
        includeExpired: false,
      },
      input.k,
    );
    knowledgeResults = knowledge.map((c) => ({
      source: "long_memory" as const,
      id: c.id,
      kind: c.kind,
      title: c.title,
      summary: c.summary,
      contentMd: c.contentMd,
      similarity: c.similarity,
      sourceTier: c.source,
      maturityState: c.maturityState,
      activationStrength: c.activationStrength,
      tags: c.tags,
      validUntil: c.validUntil ? c.validUntil.toISOString() : null,
      evidenceRefs: c.sourceRefs,
      rerankScore: scoreRecallCandidate(c, now),
    }));

    if (input.includeCandidates) {
      const candidates = await recallCandidatesTopK(
        embedding,
        { embeddingModel: providerModel, embeddingDim: embedding.length },
        input.k,
      );
      candidateResults = candidates.map((c) => ({
        source: "memory_candidate" as const,
        id: c.id,
        kind: c.kind,
        title: c.title,
        summary: c.summary,
        contentMd: c.contentMd,
        similarity: c.similarity,
        notConsolidated: true as const,
        sourceTier: c.source,
        tags: c.tags,
        evidenceRefs: c.evidenceRefs,
        retrievalUntil: c.retrievalUntil,
      }));
    } else {
      candidateResults = [];
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    memLog.error("search", "failed", { errorKind: "query_failed" });
    return { ok: false, result: fail(`MemorySearch failed: ${msg}`) };
  }

  return { ok: true, knowledgeResults, candidateResults };
}
