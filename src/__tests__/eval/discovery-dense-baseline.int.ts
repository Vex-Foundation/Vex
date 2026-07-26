/**
 * Manual real-stack eval: dense-primary discover_tools.
 *
 * This file intentionally does NOT use the `.test.ts` suffix, so default
 * `pnpm test` never picks it up. Run only with:
 *
 *   pnpm test:eval:dense
 *
 * Required local dependencies:
 * - Postgres/pgvector with migration 010 applied
 * - populated `tool_embeddings`
 * - local embedding model endpoint from ~/.config/vex/.env
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { loadProviderDotenv } from "../../providers/env-resolution.js";
import { closePool } from "../../vex-agent/db/client.js";
import { assertToolEmbeddingsReady } from "../../vex-agent/tools/protocols/embeddings/health.js";
import {
  evaluateDiscoverTools,
  formatMetrics,
  loadDataset,
  round3,
  validateDatasetExpectedTools,
  validateDatasetPrompts,
} from "./retrieval-eval-harness.js";

loadProviderDotenv();

// Agent Scan phase 1 (2026-07-22): dataset shrank 200 -> 116 (see
// tool-discovery-seed.json's description + discovery-baseline.test.ts). This
// generator's recall/mrr floors below were captured against the OLD 200-query
// set and go stale with the version bump — regenerating this baseline against
// the new dataset is the coordinator's named post-merge step, not done here.
const DATASET_VERSION = "v3-agent-116";
const REQUIRED_ENV = "VEX_REAL_DENSE_EVAL";
const RECALL5_OVERALL_FLOOR = 0.95;
const RECALL5_BLIND_FLOOR = 0.94;
const RECALL5_PROTOCOL_AWARE_FLOOR = 0.98;
const MRR5_OVERALL_FLOOR = 0.88;

const describeRealStack =
  process.env[REQUIRED_ENV] === "1" ? describe : describe.skip;

const MetricSchema = z.object({
  count: z.number().int().nonnegative(),
  recall1: z.number().min(0).max(1),
  recall5: z.number().min(0).max(1),
  coverage5: z.number().min(0).max(1),
  mrr5: z.number().min(0).max(1),
  groupMrr5: z.number().min(0).max(1),
});

const MetricsSchema = z.object({
  overall: MetricSchema,
  awareness: z.object({
    blind: MetricSchema,
    protocolAware: MetricSchema,
  }),
  intentShapes: z.object({
    single: MetricSchema,
    cross: MetricSchema,
    compare: MetricSchema,
    workflow: MetricSchema,
  }),
  scenarios: z.record(z.string(), MetricSchema),
});

const FormattedReportSchema = z.object({
  mode: z.literal("dense"),
  overall: MetricSchema,
  awareness: z.object({
    blind: MetricSchema,
    protocolAware: MetricSchema,
  }),
  intentShapes: z.object({
    single: MetricSchema,
    cross: MetricSchema,
    compare: MetricSchema,
    workflow: MetricSchema,
  }),
  scenarios: z.record(z.string(), MetricSchema),
});

const BaselineOutputSchema = z.object({
  version: z.literal(DATASET_VERSION),
  mode: z.literal("dense"),
  capturedAt: z.string(),
  datasetVersion: z.literal(DATASET_VERSION),
  status: z.literal("captured"),
  metrics: MetricsSchema,
  notes: z.array(z.string()).optional(),
});

type BaselineOutput = z.infer<typeof BaselineOutputSchema>;

function buildGateNotes(metrics: z.infer<typeof MetricsSchema>): string[] {
  const notes: string[] = [];
  if (metrics.overall.recall5 < RECALL5_OVERALL_FLOOR) {
    notes.push(`Gate failed: overall Recall@5 ${round3(metrics.overall.recall5)} < ${RECALL5_OVERALL_FLOOR}.`);
  }
  if (metrics.overall.mrr5 < MRR5_OVERALL_FLOOR) {
    notes.push(`Gate failed: overall MRR@5 ${round3(metrics.overall.mrr5)} < ${MRR5_OVERALL_FLOOR}.`);
  }
  if (metrics.awareness.blind.recall5 < RECALL5_BLIND_FLOOR) {
    notes.push(`Gate failed: blind Recall@5 ${round3(metrics.awareness.blind.recall5)} < ${RECALL5_BLIND_FLOOR}.`);
  }
  if (metrics.awareness.protocolAware.recall5 < RECALL5_PROTOCOL_AWARE_FLOOR) {
    notes.push(
      `Gate failed: protocol-aware Recall@5 ${round3(metrics.awareness.protocolAware.recall5)} < ${RECALL5_PROTOCOL_AWARE_FLOOR}.`,
    );
  }
  return notes.length > 0
    ? notes
    : ["Gate passed: dense retrieval met Recall@5 and MRR@5 floors; latency gate is captured separately."];
}

function baselinePath(): string {
  return resolve(import.meta.dirname, "baselines", "dense.json");
}

function writeBaseline(output: BaselineOutput): void {
  const validated = BaselineOutputSchema.parse(output);
  writeFileSync(baselinePath(), JSON.stringify(validated, null, 2) + "\n", "utf8");
}

describeRealStack("manual real-stack discover_tools dense baseline", () => {
  beforeAll(async () => {
    await assertToolEmbeddingsReady();
  });

  afterAll(async () => {
    await closePool();
  });

  it("captures dense-primary metrics on the v3 seed dataset", async () => {
    const queries = loadDataset();
    expect(validateDatasetPrompts(queries)).toEqual([]);
    expect(validateDatasetExpectedTools(queries)).toEqual([]);

    const report = await evaluateDiscoverTools(queries, 5);
    const formatted = FormattedReportSchema.parse(formatMetrics(report));
    const metrics = MetricsSchema.parse({
      overall: formatted.overall,
      awareness: formatted.awareness,
      intentShapes: formatted.intentShapes,
      scenarios: formatted.scenarios,
    });
    const gateNotes = buildGateNotes(metrics);
    const denseFailures = report.results
      .filter((result) => result.denseFailed || result.retrievalMethod !== "dense")
      .map((result) => ({
        query: result.query.query,
        retrievalMethod: result.retrievalMethod,
        denseFailed: result.denseFailed,
        topIds: result.topIds,
      }));

    process.stdout.write(
      JSON.stringify(
        {
          dense: formatted,
          gateNotes,
          denseFailures,
        },
        null,
        2,
      ) + "\n",
    );

    writeBaseline({
      version: DATASET_VERSION,
      mode: "dense",
      capturedAt: new Date().toISOString(),
      datasetVersion: DATASET_VERSION,
      status: "captured",
      metrics,
      notes: gateNotes,
    });

    expect(
      denseFailures,
      `Dense fallback occurred for ${denseFailures.length} queries:\n${JSON.stringify(denseFailures.slice(0, 10), null, 2)}`,
    ).toEqual([]);
    expect(metrics.overall.recall5).toBeGreaterThanOrEqual(RECALL5_OVERALL_FLOOR);
    expect(metrics.overall.mrr5).toBeGreaterThanOrEqual(MRR5_OVERALL_FLOOR);
    expect(metrics.awareness.blind.recall5).toBeGreaterThanOrEqual(RECALL5_BLIND_FLOOR);
    expect(metrics.awareness.protocolAware.recall5).toBeGreaterThanOrEqual(RECALL5_PROTOCOL_AWARE_FLOOR);
  }, 240_000);
});
