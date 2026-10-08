import { searchByVector } from "@vex-agent/db/repos/tool-embeddings.js";
import { embedQuery } from "@vex-agent/embeddings/client.js";
import {
  EmbeddingTimeoutError,
  INTERACTIVE_DISCOVERY_EMBEDDING_POLICY,
} from "@vex-agent/embeddings/call-policy.js";
import { PROTOCOL_TOOLS } from "./catalog.js";
import type { DenseFailureReason, ProtocolToolManifest } from "./types.js";
import {
  lexicalScore,
  type DiscoveryScoreOutcome,
  type ScoredManifest,
} from "./lexical-score.js";
import logger from "@utils/logger.js";
import {
  discoveryQueryPrivacyMode,
  redactDiscoveryQuery,
} from "./discovery.telemetry.js";

const DEFAULT_DISCOVERY_LIMIT = 5;

function classifyDenseFailure(err: unknown): DenseFailureReason {
  return err instanceof EmbeddingTimeoutError ? "timeout" : "error";
}

/**
 * Dense-primary retrieval for free-text protocol discovery. If embeddings,
 * DB, or table state fail, fall back to lexical scoring so callers still get
 * a useful shortlist, flagged `lowConfidence` with the failure reason.
 *
 * This is the INTERACTIVE path (a model is waiting on `ToolSearch`), so the
 * query embedding runs under {@link INTERACTIVE_DISCOVERY_EMBEDDING_POLICY}:
 * a 5 s budget with one retry, not the background 30 s x 3 attempts.
 */
export async function denseScore(
  query: string,
  candidates: ProtocolToolManifest[],
): Promise<DiscoveryScoreOutcome> {
  let embeddingModel: string | undefined;
  let embeddingDim: number | undefined;
  const startedAt = Date.now();

  try {
    const queryEmb = await embedQuery(query, undefined, INTERACTIVE_DISCOVERY_EMBEDDING_POLICY);
    embeddingModel = queryEmb.providerModel;
    embeddingDim = queryEmb.embedding.length;
    const hits = await searchByVector(queryEmb.embedding, {
      k: Math.max(PROTOCOL_TOOLS.length, candidates.length, DEFAULT_DISCOVERY_LIMIT),
      embeddingModel: queryEmb.providerModel,
      embeddingDim: queryEmb.embedding.length,
    });

    const candidatesById = new Map(candidates.map((manifest) => [manifest.toolId, manifest]));
    const scored: ScoredManifest[] = [];
    for (const hit of hits) {
      const manifest = candidatesById.get(hit.toolId);
      if (!manifest) continue;
      scored.push({
        manifest,
        score: Math.max(0, hit.similarity),
        whyMatched: ["dense"],
      });
    }

    if (scored.length === 0) {
      // THROUGH THE SANITIZER OWNER. The query is caller text - a person's
      // phrase in the app, or an external MCP agent's phrase through
      // `vex_ToolSearch` - and this module does not get its own privacy policy.
      logger.warn("discovery.dense.empty", {
        query: redactDiscoveryQuery(query),
        queryPrivacy: discoveryQueryPrivacyMode(),
        embeddingModel,
        embeddingDim,
        candidateCount: candidates.length,
      });
      return lexicalScore(query, candidates, {
        denseFailed: true,
        denseFailureReason: "no_rows",
        embeddingModel,
        embeddingDim,
      });
    }

    return {
      scored,
      meta: {
        method: "dense",
        denseFailed: false,
        embeddingModel,
        embeddingDim,
        candidateCount: candidates.length,
      },
    };
  } catch (err) {
    const denseFailureReason = classifyDenseFailure(err);
    logger.warn("discovery.dense.failed", {
      query: redactDiscoveryQuery(query),
      queryPrivacy: discoveryQueryPrivacyMode(),
      denseFailureReason,
      elapsedMs: Date.now() - startedAt,
      error: err instanceof Error ? err.message : String(err),
    });
    return lexicalScore(query, candidates, {
      denseFailed: true,
      denseFailureReason,
      embeddingModel,
      embeddingDim,
    });
  }
}
