/**
 * Real-stack eval: dense-primary discover_tools.
 *
 * This file intentionally does NOT use the `.test.ts` suffix, so default
 * `pnpm test` never picks it up. Run only with:
 *
 *   pnpm test:eval:dense           # --check (default): compares, writes nothing
 *   pnpm test:eval:dense:update    # recaptures baselines/dense.json
 *
 * Required local dependencies:
 * - Postgres/pgvector with migration 010 applied
 * - populated `tool_embeddings`
 * - local embedding model endpoint from ~/.config/vex/.env
 *
 * History (2026-08-03): this runner used to rewrite `baselines/dense.json`
 * — timestamp included — on EVERY run, which meant there was no way to assert
 * that dense quality had not moved, and it never noticed that its own baseline
 * had gone stale at `v3-agent-200` while the dataset moved to `v3-agent-116`.
 * Writing is now reachable only through an explicit `--update`.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadProviderDotenv } from "../../providers/env-resolution.js";
import { closePool } from "../../vex-agent/db/client.js";
import { assertToolEmbeddingsReady } from "../../vex-agent/tools/protocols/embeddings/health.js";
import {
  resolveBaselineMode,
  runBaselineTarget,
  type BaselineTarget,
  type MeasuredBaseline,
} from "./baseline.js";
import { toBaselineMetrics } from "./report-metrics.js";
import {
  evaluateDiscoverTools,
  loadDataset,
  round3,
  validateDatasetExpectedTools,
  validateDatasetPrompts,
} from "./retrieval-eval-harness.js";

loadProviderDotenv();

const CANONICAL_DATASET_ID = "tool-discovery-seed";
const DATASET_VERSION = "v3-agent-116";
const REQUIRED_ENV = "VEX_REAL_DENSE_EVAL";

// Quality floors — unchanged by the 2026-08-03 baseline-tooling work.
const RECALL5_OVERALL_FLOOR = 0.95;
const RECALL5_BLIND_FLOOR = 0.94;
const RECALL5_PROTOCOL_AWARE_FLOOR = 0.98;
const MRR5_OVERALL_FLOOR = 0.88;

const realStackRequested = process.env[REQUIRED_ENV] === "1";

describe("real-stack discover_tools dense baseline", () => {
  /**
   * A misconfigured run must FAIL, not skip green. This config runs nothing
   * but this file, so reaching it without the opt-in means the caller intended
   * a dense eval and did not get one.
   */
  it("runs against the real stack", () => {
    expect(
      realStackRequested,
      `${REQUIRED_ENV}=1 is required to run the dense eval. This suite evaluates nothing without `
      + "the real embedding stack, and a silent skip would report green while measuring nothing. "
      + "Use `pnpm test:eval:dense` (check) or `pnpm test:eval:dense:update` (recapture).",
    ).toBe(true);
  });

  if (!realStackRequested) return;

  beforeAll(async () => {
    await assertToolEmbeddingsReady();
  });

  afterAll(async () => {
    await closePool();
  });

  it("checks dense-primary metrics against the stored baseline", async () => {
    const mode = resolveBaselineMode(process.argv.slice(2), process.env);
    const queries = loadDataset();
    expect(validateDatasetPrompts(queries)).toEqual([]);
    expect(validateDatasetExpectedTools(queries)).toEqual([]);

    const report = await evaluateDiscoverTools(queries, 5);
    const metrics = toBaselineMetrics(report);

    const denseFailures = report.results
      .filter((result) => result.denseFailed || result.retrievalMethod !== "dense")
      .map((result) => ({
        query: result.query.query,
        retrievalMethod: result.retrievalMethod,
        denseFailed: result.denseFailed,
        topIds: result.topIds,
      }));

    const measured: MeasuredBaseline = {
      mode: "dense",
      datasetId: CANONICAL_DATASET_ID,
      datasetVersion: DATASET_VERSION,
      metrics,
    };
    const target: BaselineTarget = {
      name: "dense / canonical seed dataset",
      fileName: "dense.json",
      expectedCaseCount: queries.length,
      measure: () => measured,
    };

    const outcome = await runBaselineTarget(target, mode);
    process.stdout.write(`${outcome.report}\n`);

    // Dense fallback and the quality floors are asserted regardless of mode:
    // an --update must never be able to record a broken capture as the new
    // truth.
    expect(
      denseFailures,
      `Dense fallback occurred for ${denseFailures.length} queries:\n${JSON.stringify(denseFailures.slice(0, 10), null, 2)}`,
    ).toEqual([]);
    expect(round3(metrics.overall.recall5)).toBeGreaterThanOrEqual(RECALL5_OVERALL_FLOOR);
    expect(round3(metrics.overall.mrr5)).toBeGreaterThanOrEqual(MRR5_OVERALL_FLOOR);
    expect(round3(metrics.awareness?.blind.recall5 ?? 0)).toBeGreaterThanOrEqual(RECALL5_BLIND_FLOOR);
    expect(round3(metrics.awareness?.protocolAware.recall5 ?? 0))
      .toBeGreaterThanOrEqual(RECALL5_PROTOCOL_AWARE_FLOOR);

    expect(outcome.ok, outcome.report).toBe(true);
  }, 240_000);
});
