import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import {
  PROTOCOL_TOOLS,
  isAdvertisedProtocolNamespace,
} from "../../vex-agent/tools/protocols/catalog.js";
import { discoverProtocolCapabilities } from "../../vex-agent/tools/protocols/runtime.js";
import type { ProtocolToolManifest } from "../../vex-agent/tools/protocols/types.js";

export const AWARENESS_NAMES = ["blind", "protocol-aware"] as const;
export const INTENT_SHAPES = ["single", "cross", "compare", "workflow"] as const;
export const SCENARIOS = [
  "account_history",
  "bridge",
  "evm_lp",
  "evm_swap",
  "limit_order",
  "market_research",
  "prediction_discovery",
  "prediction_trading",
  "rewards",
  "solana_lend",
  "solana_swap",
  "token_safety",
  "workflow",
] as const;

/**
 * Brands a "protocol-aware" query may name, and a "blind" query may not.
 *
 * Solana is deliberately ABSENT: it is a chain word, used as such by twelve
 * frozen blind seed rows, and Jupiter is the protocol-aware term for the
 * `solana` namespace. Polymarket is gone with the retired namespace.
 */
const PROTOCOL_NAME_RE =
  /\b(Khalani|KyberSwap|Jupiter|DexScreener|Morpho|Pendle|Relay|Virtuals|Trench|Uniswap)\b|\bpools\.fun\b/i;

/**
 * Retired or internal vocabulary that must never reach a dataset query.
 *
 * This used to also reject EVERY dotted token, which cannot distinguish an
 * internal function name from the brand `pools.fun`. Tool-identity leakage is
 * now checked against the live catalog itself
 * ({@link findCatalogIdentityLeaks}), which is exact rather than shaped.
 */
const INTERNAL_TOOL_RE = /\b(gamma|clob|tokenpairs|zap)\b/i;

const SeedQuerySchema = z.object({
  query: z.string().min(1),
  awareness: z.enum(AWARENESS_NAMES),
  scenario: z.enum(SCENARIOS),
  intentShape: z.enum(INTENT_SHAPES),
  expectedToolIds: z.array(z.string().min(1)).min(1),
  expectedCoverageGroups: z.array(z.array(z.string().min(1)).min(1)).min(1),
});

const SeedDatasetSchema = z.object({
  // Agent Scan phase 1 (2026-07-22): shrunk from v3-agent-200 to v3-agent-116
  // - polymarket/zap/limitOrder/old-buy-sell rows removed, no backfill (see
  // tool-discovery-seed.json's description + discovery-baseline.test.ts for
  // the count-lockstep decision). Same v3 schema shape, smaller curated count.
  // S3.5 (2026-08-24): shrunk again to v4-agent-109 when the 12 public-API
  // DexScreener tools were retired whole and alias-free (owner decision
  // D-DS2). 13 rows were retargeted in place onto the tool that now answers
  // the same question; 7 were deleted outright because plan 4.6 records their
  // subject as a named omission with no successor. No query text was invented
  // to backfill the count, for the same reason phase 1 did not.
  version: z.literal("v4-agent-109"),
  description: z.string(),
  queries: z.array(SeedQuerySchema).length(109),
});

export type SeedQuery = z.infer<typeof SeedQuerySchema>;
export type AwarenessName = SeedQuery["awareness"];
export type IntentShapeName = SeedQuery["intentShape"];
export type ScenarioName = SeedQuery["scenario"];
export type RetrievalEvalMode = "dense" | "lexical";

export interface QueryResult {
  query: SeedQuery;
  topIds: string[];
  hitRank: number;
  coverageHit: boolean;
  groupMrr5: number;
  denseFailed: boolean;
  retrievalMethod: string | undefined;
  /**
   * Candidates the retrieval leg scored for THIS row, as the discovery result
   * reported it. Recorded per row because a shrunken catalog (an unset
   * `requiresEnv`) is otherwise invisible in the metrics.
   */
  candidateCount: number | undefined;
}

export interface Metrics {
  count: number;
  recall1: number;
  recall5: number;
  coverage5: number;
  mrr5: number;
  groupMrr5: number;
  misses: QueryResult[];
  coverageMisses: QueryResult[];
}

export interface ModeReport {
  mode: RetrievalEvalMode;
  results: QueryResult[];
  metrics: {
    overall: Metrics;
    awareness: Record<AwarenessName, Metrics>;
    intentShapes: Record<IntentShapeName, Metrics>;
    scenarios: Record<ScenarioName, Metrics>;
  };
}

export function loadDataset(): readonly SeedQuery[] {
  const path = resolve(import.meta.dirname, "datasets", "tool-discovery-seed.json");
  const raw = readFileSync(path, "utf8");
  const json: unknown = JSON.parse(raw);
  const parsed = SeedDatasetSchema.parse(json);
  return parsed.queries;
}

/**
 * The tools an eval dataset may reference: active lifecycle, advertised
 * namespace.
 *
 * Availability (`requiresEnv`) is deliberately NOT applied here. A dataset is a
 * contract over the catalog, not over one machine's environment; the runner is
 * what has to prove the candidate set it measured (see
 * `dense-measurement.ts`).
 */
export function liveProtocolManifests(): readonly ProtocolToolManifest[] {
  return PROTOCOL_TOOLS
    .filter((manifest) => manifest.lifecycle === "active")
    .filter((manifest) => isAdvertisedProtocolNamespace(manifest.namespace));
}

/**
 * Live tool identities (`toolId` AND `publicName`) appearing verbatim in a
 * query.
 *
 * Both identities matter: `toolid-pin.ts` pins an exact or uniquely prefixing
 * name at rank 0, so a query carrying one measures the pin, not retrieval.
 * Matching is whole-token and case-insensitive; surrounding punctuation and
 * sentence-final dots are stripped so "use morpho.markets.discover." is caught.
 */
export function findCatalogIdentityLeaks(query: string): string[] {
  const identities = new Set<string>();
  for (const manifest of liveProtocolManifests()) {
    identities.add(manifest.toolId.toLowerCase());
    identities.add(manifest.publicName.toLowerCase());
  }

  const leaks: string[] = [];
  for (const rawToken of query.toLowerCase().split(/[^a-z0-9_.]+/)) {
    const token = rawToken.replace(/^\.+/, "").replace(/\.+$/, "");
    if (token.length > 0 && identities.has(token) && !leaks.includes(token)) leaks.push(token);
  }
  return leaks;
}

export function validateDatasetExpectedTools(queries: readonly SeedQuery[]): string[] {
  const activeToolIds = liveProtocolManifests().map((manifest) => manifest.toolId);
  const problems: string[] = [];

  for (const query of queries) {
    const expectedIds = [
      ...query.expectedToolIds,
      ...query.expectedCoverageGroups.flat(),
    ];
    for (const expectedId of expectedIds) {
      if (!isValidExpectedToolId(expectedId, activeToolIds)) {
        problems.push(`"${query.query}" references unknown expected tool "${expectedId}"`);
      }
    }
  }

  return problems;
}

export function validateDatasetPrompts(queries: readonly SeedQuery[]): string[] {
  const problems: string[] = [];

  for (const query of queries) {
    if (query.awareness === "blind" && PROTOCOL_NAME_RE.test(query.query)) {
      problems.push(`Blind query leaks protocol name: "${query.query}"`);
    }
    if (query.awareness === "protocol-aware" && !PROTOCOL_NAME_RE.test(query.query)) {
      problems.push(`Protocol-aware query does not name a protocol: "${query.query}"`);
    }
    if (query.awareness === "protocol-aware" && INTERNAL_TOOL_RE.test(query.query)) {
      problems.push(`Protocol-aware query leaks internal function/tool naming: "${query.query}"`);
    }
    const leaks = findCatalogIdentityLeaks(query.query);
    if (leaks.length > 0) {
      problems.push(`Query names live tool identities (${leaks.join(", ")}): "${query.query}"`);
    }
  }

  return problems;
}

export async function evaluateDiscoverTools(
  queries: readonly SeedQuery[],
  limit: number,
): Promise<ModeReport> {
  const results: QueryResult[] = [];
  for (const query of queries) {
    results.push(await evaluateDiscoverQuery(query, limit));
  }
  return buildModeReport("dense", results);
}

export function aggregate(results: readonly QueryResult[]): Metrics {
  let recall1Hits = 0;
  let recall5Hits = 0;
  let coverage5Hits = 0;
  let reciprocalRankSum = 0;
  let groupReciprocalRankSum = 0;
  const misses: QueryResult[] = [];
  const coverageMisses: QueryResult[] = [];

  for (const result of results) {
    groupReciprocalRankSum += result.groupMrr5;
    if (result.hitRank === 0) recall1Hits++;
    if (result.hitRank >= 0 && result.hitRank < 5) {
      recall5Hits++;
      reciprocalRankSum += 1 / (result.hitRank + 1);
    } else {
      misses.push(result);
    }
    if (result.coverageHit) {
      coverage5Hits++;
    } else {
      coverageMisses.push(result);
    }
  }

  return {
    count: results.length,
    recall1: results.length > 0 ? recall1Hits / results.length : 0,
    recall5: results.length > 0 ? recall5Hits / results.length : 0,
    coverage5: results.length > 0 ? coverage5Hits / results.length : 0,
    mrr5: results.length > 0 ? reciprocalRankSum / results.length : 0,
    groupMrr5: results.length > 0 ? groupReciprocalRankSum / results.length : 0,
    misses,
    coverageMisses,
  };
}

export function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export function formatMetrics(report: ModeReport): object {
  return {
    mode: report.mode,
    overall: compactMetrics(report.metrics.overall),
    awareness: {
      blind: compactMetrics(report.metrics.awareness.blind),
      protocolAware: compactMetrics(report.metrics.awareness["protocol-aware"]),
    },
    intentShapes: {
      single: compactMetrics(report.metrics.intentShapes.single),
      cross: compactMetrics(report.metrics.intentShapes.cross),
      compare: compactMetrics(report.metrics.intentShapes.compare),
      workflow: compactMetrics(report.metrics.intentShapes.workflow),
    },
    scenarios: Object.fromEntries(
      SCENARIOS.map((scenario) => [scenario, compactMetrics(report.metrics.scenarios[scenario])]),
    ),
  };
}

export function evaluateExpectedMatch(actualId: string, expectedId: string): boolean {
  return actualId === expectedId || actualId.startsWith(`${expectedId}.`);
}

export function findHitRank(
  topIds: readonly string[],
  expectedToolIds: readonly string[],
): number {
  for (let index = 0; index < topIds.length; index++) {
    const id = topIds[index];
    if (id === undefined) continue;
    const matched = expectedToolIds.some((expectedId) => evaluateExpectedMatch(id, expectedId));
    if (matched) return index;
  }
  return -1;
}

export function isCoverageHit(
  topIds: readonly string[],
  expectedCoverageGroups: readonly (readonly string[])[],
): boolean {
  return expectedCoverageGroups.every((group) =>
    findGroupRank(topIds, group) >= 0 && findGroupRank(topIds, group) < 5,
  );
}

export function findGroupRank(topIds: readonly string[], group: readonly string[]): number {
  for (let index = 0; index < topIds.length; index++) {
    const id = topIds[index];
    if (id === undefined) continue;
    if (group.some((expectedId) => evaluateExpectedMatch(id, expectedId))) return index;
  }
  return -1;
}

export function groupMrr5(
  topIds: readonly string[],
  expectedCoverageGroups: readonly (readonly string[])[],
): number {
  if (expectedCoverageGroups.length === 0) return 0;
  let reciprocalRankSum = 0;
  for (const group of expectedCoverageGroups) {
    const rank = findGroupRank(topIds, group);
    if (rank >= 0 && rank < 5) reciprocalRankSum += 1 / (rank + 1);
  }
  return reciprocalRankSum / expectedCoverageGroups.length;
}

async function evaluateDiscoverQuery(query: SeedQuery, limit: number): Promise<QueryResult> {
  const result = await discoverProtocolCapabilities({ query: query.query, limit });
  const topIds = result.tools.map((tool) => tool.toolId);
  return {
    query,
    topIds,
    hitRank: findHitRank(topIds, query.expectedToolIds),
    coverageHit: isCoverageHit(topIds, query.expectedCoverageGroups),
    groupMrr5: groupMrr5(topIds, query.expectedCoverageGroups),
    denseFailed: result.retrieval?.denseFailed ?? false,
    retrievalMethod: result.retrieval?.method,
    candidateCount: result.retrieval?.candidateCount,
  };
}

export function buildModeReport(mode: RetrievalEvalMode, results: QueryResult[]): ModeReport {
  const awareness = splitByAwareness(results);
  const intentShapes = splitByIntentShape(results);
  const scenarios = splitByScenario(results);
  return {
    mode,
    results,
    metrics: {
      overall: aggregate(results),
      awareness: {
        blind: aggregate(awareness.blind),
        "protocol-aware": aggregate(awareness["protocol-aware"]),
      },
      intentShapes: {
        single: aggregate(intentShapes.single),
        cross: aggregate(intentShapes.cross),
        compare: aggregate(intentShapes.compare),
        workflow: aggregate(intentShapes.workflow),
      },
      scenarios: {
        account_history: aggregate(scenarios.account_history),
        bridge: aggregate(scenarios.bridge),
        evm_lp: aggregate(scenarios.evm_lp),
        evm_swap: aggregate(scenarios.evm_swap),
        limit_order: aggregate(scenarios.limit_order),
        market_research: aggregate(scenarios.market_research),
        prediction_discovery: aggregate(scenarios.prediction_discovery),
        prediction_trading: aggregate(scenarios.prediction_trading),
        rewards: aggregate(scenarios.rewards),
        solana_lend: aggregate(scenarios.solana_lend),
        solana_swap: aggregate(scenarios.solana_swap),
        token_safety: aggregate(scenarios.token_safety),
        workflow: aggregate(scenarios.workflow),
      },
    },
  };
}

function splitByAwareness(results: readonly QueryResult[]): Record<AwarenessName, QueryResult[]> {
  return {
    blind: results.filter((result) => result.query.awareness === "blind"),
    "protocol-aware": results.filter((result) => result.query.awareness === "protocol-aware"),
  };
}

function splitByIntentShape(results: readonly QueryResult[]): Record<IntentShapeName, QueryResult[]> {
  return {
    single: results.filter((result) => result.query.intentShape === "single"),
    cross: results.filter((result) => result.query.intentShape === "cross"),
    compare: results.filter((result) => result.query.intentShape === "compare"),
    workflow: results.filter((result) => result.query.intentShape === "workflow"),
  };
}

function splitByScenario(results: readonly QueryResult[]): Record<ScenarioName, QueryResult[]> {
  return {
    account_history: results.filter((result) => result.query.scenario === "account_history"),
    bridge: results.filter((result) => result.query.scenario === "bridge"),
    evm_lp: results.filter((result) => result.query.scenario === "evm_lp"),
    evm_swap: results.filter((result) => result.query.scenario === "evm_swap"),
    limit_order: results.filter((result) => result.query.scenario === "limit_order"),
    market_research: results.filter((result) => result.query.scenario === "market_research"),
    prediction_discovery: results.filter((result) => result.query.scenario === "prediction_discovery"),
    prediction_trading: results.filter((result) => result.query.scenario === "prediction_trading"),
    rewards: results.filter((result) => result.query.scenario === "rewards"),
    solana_lend: results.filter((result) => result.query.scenario === "solana_lend"),
    solana_swap: results.filter((result) => result.query.scenario === "solana_swap"),
    token_safety: results.filter((result) => result.query.scenario === "token_safety"),
    workflow: results.filter((result) => result.query.scenario === "workflow"),
  };
}

function compactMetrics(metrics: Metrics): object {
  return {
    count: metrics.count,
    recall1: round3(metrics.recall1),
    recall5: round3(metrics.recall5),
    coverage5: round3(metrics.coverage5),
    mrr5: round3(metrics.mrr5),
    groupMrr5: round3(metrics.groupMrr5),
  };
}

function isValidExpectedToolId(expectedId: string, activeToolIds: readonly string[]): boolean {
  return activeToolIds.some((toolId) =>
    toolId === expectedId || toolId.startsWith(`${expectedId}.`),
  );
}
