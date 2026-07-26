import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import {
  PROTOCOL_TOOLS,
  isAdvertisedProtocolNamespace,
} from "../../vex-agent/tools/protocols/catalog.js";
import { discoverProtocolCapabilities } from "../../vex-agent/tools/protocols/runtime.js";

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

const PROTOCOL_NAME_RE = /\b(Khalani|KyberSwap|Jupiter|Polymarket|DexScreener)\b/i;
const INTERNAL_TOOL_RE = /\b(gamma|clob|tokenpairs|zap)\b|[a-z]+\.[a-z]+/i;

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
  // — polymarket/zap/limitOrder/old-buy-sell rows removed, no backfill (see
  // tool-discovery-seed.json's description + discovery-baseline.test.ts for
  // the count-lockstep decision). Same v3 schema shape, smaller curated count.
  version: z.literal("v3-agent-116"),
  description: z.string(),
  queries: z.array(SeedQuerySchema).length(116),
});

export type SeedQuery = z.infer<typeof SeedQuerySchema>;
export type AwarenessName = SeedQuery["awareness"];
export type IntentShapeName = SeedQuery["intentShape"];
export type ScenarioName = SeedQuery["scenario"];
export type RetrievalEvalMode = "dense";

export interface QueryResult {
  query: SeedQuery;
  topIds: string[];
  hitRank: number;
  coverageHit: boolean;
  groupMrr5: number;
  denseFailed: boolean;
  retrievalMethod: string | undefined;
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

export function validateDatasetExpectedTools(queries: readonly SeedQuery[]): string[] {
  const activeToolIds = PROTOCOL_TOOLS
    .filter((manifest) => manifest.lifecycle === "active")
    .filter((manifest) => isAdvertisedProtocolNamespace(manifest.namespace))
    .map((manifest) => manifest.toolId);
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
  };
}

function buildModeReport(mode: RetrievalEvalMode, results: QueryResult[]): ModeReport {
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
