/**
 * v3 — discover_tools latency benchmark (dense mode).
 *
 * Manual real-stack benchmark. Measures wallclock time of
 * `discoverProtocolCapabilities` across the full seed dataset in dense mode.
 *
 * This file intentionally does NOT use the `.test.ts` suffix, so default
 * `pnpm test` never picks it up. Run only with:
 *
 *   pnpm test:eval:latency
 *
 * Methodology:
 *   - Warm-up: 5 queries, discarded (warms DB connection pool + pgvector plan
 *     cache + embedding sidecar).
 *   - Measurement: 200 queries x 3 trials = 600 invocations, sequential.
 *   - Metrics: p50, p95, p99 (percentiles over the 600 measurements).
 *   - Output: written to `baselines/dense-latency.json` for trend tracking.
 *
 * Gate: p95 ≤ 750ms on a warm sidecar. On first capture this is informational
 * — the test records the number even if it fails the gate so the architect can
 * decide whether to investigate ANN indexing.
 *
 * Requires a live local stack: Postgres vex@5777 + Docker Model Runner at
 * EMBEDDING_BASE_URL. `assertToolEmbeddingsReady()` fails fast if the table
 * is empty or mismatched.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
// Load provider dotenv before any module reading process.env (same pattern
// as the baseline test and maintenance scripts).
import { loadProviderDotenv } from "../../providers/env-resolution.js";
loadProviderDotenv();
import { discoverProtocolCapabilities } from "../../vex-agent/tools/protocols/runtime.js";
import { closePool } from "../../vex-agent/db/client.js";
import { assertToolEmbeddingsReady } from "../../vex-agent/tools/protocols/embeddings/health.js";

// ── Dataset ──────────────────────────────────────────────────────

interface SeedQuery {
  query: string;
}

function loadQueries(): readonly string[] {
  const path = resolve(import.meta.dirname, "datasets", "tool-discovery-seed.json");
  const raw = readFileSync(path, "utf8");
  const data = JSON.parse(raw) as { queries: SeedQuery[] };
  return data.queries.map((q) => q.query);
}

const SEED_QUERIES = loadQueries();

// ── Benchmark config ─────────────────────────────────────────────

const WARMUP_QUERIES = 5;
const TRIALS_PER_QUERY = 3;
const P95_GATE_MS = 750;
const REQUIRED_ENV = "VEX_REAL_LATENCY_EVAL";
const describeRealStack =
  process.env[REQUIRED_ENV] === "1" ? describe : describe.skip;

// ── Percentile helper ────────────────────────────────────────────

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.max(0, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx]!;
}

// ── Output schema ────────────────────────────────────────────────

const LatencyOutputSchema = z.object({
  // Agent Scan phase 1 (2026-07-22): dataset shrank 200 -> 116 (see
  // tool-discovery-seed.json's description). This baseline's captured
  // latencies go stale with the version bump — regeneration is the
  // coordinator's named post-merge step, not done here.
  version: z.literal("v3-agent-116"),
  mode: z.literal("dense"),
  capturedAt: z.string(),
  methodology: z.object({
    warmupQueries: z.number().int(),
    trialsPerQuery: z.number().int(),
    totalMeasurements: z.number().int(),
  }),
  latencyMs: z.object({
    p50: z.number().nonnegative(),
    p95: z.number().nonnegative(),
    p99: z.number().nonnegative(),
    min: z.number().nonnegative(),
    max: z.number().nonnegative(),
  }),
  gate: z.object({
    p95ThresholdMs: z.number(),
    passed: z.boolean(),
  }),
});

type LatencyOutput = z.infer<typeof LatencyOutputSchema>;

// ── Test suite ───────────────────────────────────────────────────

describeRealStack("v3 — discover_tools latency benchmark (dense mode)", () => {
  beforeAll(async () => {
    await assertToolEmbeddingsReady();
  });

  afterAll(async () => {
    await closePool();
  });

  it(
    "p95 latency <= 750ms on warm sidecar (600 measurements)",
    async () => {
      // Warm up: run the first WARMUP_QUERIES queries once each, discard.
      for (const query of SEED_QUERIES.slice(0, WARMUP_QUERIES)) {
        await discoverProtocolCapabilities({ query, limit: 5 });
      }

      // Measurement: TRIALS_PER_QUERY passes over the full seed.
      const measurements: number[] = [];
      for (let trial = 0; trial < TRIALS_PER_QUERY; trial++) {
        for (const query of SEED_QUERIES) {
          const t0 = performance.now();
          await discoverProtocolCapabilities({ query, limit: 5 });
          const elapsed = performance.now() - t0;
          measurements.push(elapsed);
        }
      }

      measurements.sort((a, b) => a - b);

      const p50 = percentile(measurements, 50);
      const p95 = percentile(measurements, 95);
      const p99 = percentile(measurements, 99);
      const min = measurements[0] ?? 0;
      const max = measurements[measurements.length - 1] ?? 0;

      const gatePassed = p95 <= P95_GATE_MS;

      const output: LatencyOutput = {
        version: "v3-agent-116",
        mode: "dense",
        capturedAt: new Date().toISOString(),
        methodology: {
          warmupQueries: WARMUP_QUERIES,
          trialsPerQuery: TRIALS_PER_QUERY,
          totalMeasurements: measurements.length,
        },
        latencyMs: {
          p50: Math.round(p50),
          p95: Math.round(p95),
          p99: Math.round(p99),
          min: Math.round(min),
          max: Math.round(max),
        },
        gate: {
          p95ThresholdMs: P95_GATE_MS,
          passed: gatePassed,
        },
      };

      const validated = LatencyOutputSchema.parse(output);
      const outPath = resolve(import.meta.dirname, "baselines", "dense-latency.json");
      writeFileSync(outPath, JSON.stringify(validated, null, 2) + "\n", "utf8");

      // eslint-disable-next-line no-console
      console.log("[v3 latency]", JSON.stringify({
        p50Ms: Math.round(p50),
        p95Ms: Math.round(p95),
        p99Ms: Math.round(p99),
        minMs: Math.round(min),
        maxMs: Math.round(max),
        totalMeasurements: measurements.length,
        gatePassed,
      }));

      // Fail the test if p95 exceeds the gate threshold. On first capture
      // this surfacing of the number matters more than the pass/fail, but
      // the gate is the contract — if p95 > 750ms the architect needs to
      // decide before keeping dense discovery as the default.
      expect(
        p95,
        `Dense p95 latency ${Math.round(p95)}ms exceeds gate ${P95_GATE_MS}ms. ` +
          `Consider ANN indexing (ivfflat/hnsw) or async parallel queries. ` +
          `See baselines/dense-latency.json for full breakdown.`,
      ).toBeLessThanOrEqual(P95_GATE_MS);
    },
    // 600 queries at ~200ms each = ~120s. 300s ceiling provides headroom for
    // slow first-connection setup and pgvector cold plan.
    300_000,
  );
});
