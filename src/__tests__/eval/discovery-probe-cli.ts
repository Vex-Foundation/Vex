#!/usr/bin/env tsx
/**
 * Per-namespace retrieval probe.
 *
 *   npx tsx src/__tests__/eval/discovery-probe-cli.ts --namespace <ns> --validate-only
 *   VEX_DB_URL=... VEX_EVAL_REQUIRES_ENV_SENTINELS=1 \
 *     npx tsx src/__tests__/eval/discovery-probe-cli.ts --namespace <ns>
 *
 * Read-only measurement of what `ToolSearch` returns for a namespace's dataset,
 * for the D9 retrieval findings. It writes no baseline and no dataset.
 *
 * Two modes:
 * - `--validate-only` runs the dataset validators with NO database and NO
 *   embedding access, so a dataset author can self-check a file offline. It is
 *   the ONLY mode that touches nothing external.
 * - the full mode measures the real dense path.
 *
 * Design constraints that are not negotiable here:
 * - the dataset path is derived from the namespace; no caller passes a
 *   filesystem path;
 * - retrieval stays GLOBAL (no namespace argument to
 *   `discoverProtocolCapabilities`), because the agent's own query mode almost
 *   never sets one and narrowing would measure an easier problem;
 * - `VEX_DB_URL` is REQUIRED, mirroring `scripts/_preflight.ts`. The db client
 *   silently falls back to a dev database when it is unset, which makes the
 *   dense leg throw and degrade to lexical: a measurement that reports numbers
 *   for the wrong retrieval path;
 * - every row must be a real dense measurement over the FULL catalog
 *   (`dense-measurement.ts`);
 * - output is complete. No list printed here is ever shortened.
 */

import { loadProviderDotenv } from "../../providers/env-resolution.js";
import { closePool } from "../../vex-agent/db/client.js";
import { assertToolEmbeddingsReady } from "../../vex-agent/tools/protocols/embeddings/health.js";
import { assertDenseMeasurement } from "./dense-measurement.js";
import { DISCOVERY_LIMIT } from "./eval-targets.js";
import { expectedCandidateCount } from "./live-catalog.js";
import {
  isLiveEvalNamespace,
  liveEvalNamespaces,
  loadNamespaceDataset,
  namespaceDatasetExists,
  namespaceDatasetPath,
  validateNamespaceDataset,
  type NamespaceDataset,
} from "./namespace-dataset.js";
import {
  applyRequiresEnvSentinels,
  describeAppliedSentinels,
  SENTINEL_ENV_FLAG,
} from "./requires-env-sentinels.js";
import {
  evaluateDiscoverTools,
  liveProtocolManifests,
  round3,
  validateDatasetPrompts,
} from "./retrieval-eval-harness.js";

interface Args {
  namespace: string;
  validateOnly: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  const index = argv.indexOf("--namespace");
  const value = index === -1 ? undefined : argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(
      `--namespace <ns> is required. Live namespaces: ${liveEvalNamespaces().join(", ")}.`,
    );
  }
  if (!isLiveEvalNamespace(value)) {
    throw new Error(
      `"${value}" is not a live protocol namespace. Live namespaces: ${liveEvalNamespaces().join(", ")}.`,
    );
  }
  return { namespace: value, validateOnly: argv.includes("--validate-only") };
}

/**
 * Every validator that applies to a per-namespace dataset, reported in full.
 *
 * The two validators overlap on tool-identity leakage by design (the brand
 * rules own the seed dataset too), so identical problems are reported once.
 */
function validate(dataset: NamespaceDataset): string[] {
  return [...new Set([
    ...validateDatasetPrompts(dataset.queries),
    ...validateNamespaceDataset(dataset),
  ])];
}

function assertExplicitDbUrl(): void {
  if ((process.env.VEX_DB_URL ?? "").trim().length === 0) {
    throw new Error(
      "VEX_DB_URL is required for the retrieval probe. Refusing to run with the db client's dev "
      + "fallback: a wrong database has no tool_embeddings rows, the dense leg degrades to "
      + "lexical, and the run would report retrieval numbers for the wrong path. Export it for "
      + "the database you intend to read, for example:\n"
      + "  export VEX_DB_URL=postgresql://vex:<password>@127.0.0.1:27432/vex",
    );
  }
}

function publicNameIndex(): Map<string, string> {
  return new Map(liveProtocolManifests().map((manifest) => [manifest.toolId, manifest.publicName]));
}

async function measure(dataset: NamespaceDataset): Promise<number> {
  assertExplicitDbUrl();

  // The probe writes no baseline, so the sentinels stay opt-in here. Without
  // the flag the run still cannot report a reduced catalog as a result: the
  // expected count below is environment-independent, so
  // `assertDenseMeasurement` fails the run by name instead.
  if (process.env[SENTINEL_ENV_FLAG] === "1") {
    process.stdout.write(
      `${SENTINEL_ENV_FLAG}=1: ${describeAppliedSentinels(applyRequiresEnvSentinels())}\n`,
    );
  }

  const expected = expectedCandidateCount();
  await assertToolEmbeddingsReady();

  const report = await evaluateDiscoverTools(dataset.queries, DISCOVERY_LIMIT);
  const publicNames = publicNameIndex();

  process.stdout.write(`\nRows (${report.results.length}):\n`);
  for (const result of report.results) {
    process.stdout.write(
      `\n  query: ${result.query.query}\n`
      + `    awareness: ${result.query.awareness}, intentShape: ${result.query.intentShape}, scenario: ${result.query.scenario}\n`
      + `    expected: ${result.query.expectedToolIds.join(", ")}\n`
      + `    hitRank: ${result.hitRank === -1 ? "MISS" : String(result.hitRank + 1)}\n`
      + `    top${DISCOVERY_LIMIT}: ${result.topIds.map((id) => publicNames.get(id) ?? id).join(", ")}\n`
      + `    retrievalMethod: ${String(result.retrievalMethod)}, denseFailed: ${String(result.denseFailed)}, candidateCount: ${String(result.candidateCount)}\n`,
    );
  }

  assertDenseMeasurement(report, expected, `retrieval probe / ${dataset.namespace}`);

  const overall = report.metrics.overall;
  process.stdout.write(
    `\nMetrics for ${dataset.namespace} (${overall.count} rows, candidate set ${expected}):\n`
    + `  recall@1: ${round3(overall.recall1)}\n`
    + `  recall@5: ${round3(overall.recall5)}\n`
    + `  mrr@5: ${round3(overall.mrr5)}\n`,
  );
  return 0;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));

  if (!namespaceDatasetExists(args.namespace)) {
    process.stderr.write(
      `No dataset for "${args.namespace}" at ${namespaceDatasetPath(args.namespace)}.\n`,
    );
    return 1;
  }

  const dataset = loadNamespaceDataset(args.namespace);
  const problems = validate(dataset);
  if (problems.length > 0) {
    process.stderr.write(
      `Dataset ${namespaceDatasetPath(args.namespace)} has ${problems.length} validation problem(s):\n`
      + `${problems.map((problem) => `  ${problem}`).join("\n")}\n`,
    );
    return 1;
  }
  process.stdout.write(
    `Dataset ${dataset.namespace}@${dataset.version} is valid: ${dataset.queries.length} rows, `
    + "coverage complete, no tool identity leaked.\n",
  );

  if (args.validateOnly) return 0;

  // `loadProviderDotenv` reads the embedding endpoint config only; it never
  // loads managed secrets.
  loadProviderDotenv();
  return await measure(dataset);
}

main().then(
  async (code) => {
    await closePool();
    process.exitCode = code;
  },
  async (err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    await closePool();
    process.exitCode = 1;
  },
);
