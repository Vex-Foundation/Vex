/**
 * Lexical-lane retrieval evaluation.
 *
 * `lexicalScore` is a LIVE product path, not a historical one: it is the
 * fallback `dense-score.ts` degrades to whenever the embedding endpoint, the
 * DB, or `tool_embeddings` is unavailable. Evaluating it is therefore
 * evaluating the behavior real agents get on a bad day — and, unlike the dense
 * lane, it needs no credentials, no Postgres and no embedding sidecar, so it
 * can gate every ordinary change.
 *
 * The candidate set is rebuilt here from the same public catalog predicates
 * `discovery.ts` uses, because that filter is a private const there. The
 * duplication is not left to rot on trust: `lexical-retrieval.test.ts` asserts
 * this candidate count equals the `candidateCount` that
 * `discoverProtocolCapabilities` itself reports, so a divergence fails a test
 * instead of silently skewing the eval.
 */

import {
  PROTOCOL_TOOLS,
  isAdvertisedProtocolNamespace,
  isProtocolToolAvailable,
} from "../../vex-agent/tools/protocols/catalog.js";
import { lexicalScore } from "../../vex-agent/tools/protocols/lexical-score.js";
import { pinExactToolIdMatch } from "../../vex-agent/tools/protocols/toolid-pin.js";
import type { ProtocolToolManifest } from "../../vex-agent/tools/protocols/types.js";
import {
  buildModeReport,
  findHitRank,
  groupMrr5,
  isCoverageHit,
  type ModeReport,
  type QueryResult,
  type SeedQuery,
} from "./retrieval-eval-harness.js";

/**
 * Mirrors `discovery.ts`'s candidate filter for a session-less caller.
 *
 * The Uniswap reveal gate is intentionally absent: the `uniswap` namespace is
 * not an advertised namespace, so both of its manifests are already removed by
 * the advertised-namespace filter and the reveal gate would be a no-op here.
 */
export function buildDiscoveryCandidates(): ProtocolToolManifest[] {
  return PROTOCOL_TOOLS
    .filter((manifest) => isAdvertisedProtocolNamespace(manifest.namespace))
    .filter((manifest) => isProtocolToolAvailable(manifest));
}

export function lexicalTopIds(
  query: string,
  limit: number,
  candidates: readonly ProtocolToolManifest[],
): string[] {
  const outcome = lexicalScore(query, [...candidates]);
  const pinned = pinExactToolIdMatch(query, candidates, outcome.scored);
  return pinned.slice(0, limit).map((entry) => entry.manifest.toolId);
}

export function evaluateLexicalQueries(
  queries: readonly SeedQuery[],
  limit: number,
  candidates: readonly ProtocolToolManifest[] = buildDiscoveryCandidates(),
): QueryResult[] {
  return queries.map((query) => {
    const topIds = lexicalTopIds(query.query, limit, candidates);
    return {
      query,
      topIds,
      hitRank: findHitRank(topIds, query.expectedToolIds),
      coverageHit: isCoverageHit(topIds, query.expectedCoverageGroups),
      groupMrr5: groupMrr5(topIds, query.expectedCoverageGroups),
      denseFailed: false,
      retrievalMethod: "lexical",
    };
  });
}

export function evaluateLexicalDiscovery(
  queries: readonly SeedQuery[],
  limit: number,
): ModeReport {
  return buildModeReport("lexical", evaluateLexicalQueries(queries, limit));
}
