import { searchByVector } from "@vex-agent/db/repos/tool-embeddings.js";
import { embedQuery } from "@vex-agent/embeddings/client.js";
import { PROTOCOL_TOOLS } from "./catalog.js";
import type { ProtocolToolManifest } from "./types.js";
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

/**
 * Dense-primary retrieval for free-text protocol discovery. If embeddings,
 * DB, or table state fail, fall back to lexical scoring so callers still get
 * a useful shortlist.
 */
export async function denseScore(
  query: string,
  candidates: ProtocolToolManifest[],
): Promise<DiscoveryScoreOutcome> {
  let embeddingModel: string | undefined;
  let embeddingDim: number | undefined;

  try {
    const queryEmb = await embedQuery(query);
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
    logger.warn("discovery.dense.failed", {
      query: redactDiscoveryQuery(query),
      queryPrivacy: discoveryQueryPrivacyMode(),
      error: err instanceof Error ? err.message : String(err),
    });
    return lexicalScore(query, candidates, {
      denseFailed: true,
      embeddingModel,
      embeddingDim,
    });
  }
}
