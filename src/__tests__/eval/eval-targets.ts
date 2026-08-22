/**
 * The single registry of retrieval-eval datasets and the baseline targets each
 * one produces, for BOTH lanes.
 *
 * One owner instead of hand-written per-dataset blocks in the lexical CLI and
 * the dense runner: eleven namespaces times two lanes is twenty-two blocks that
 * would drift apart, and the per-namespace files are authored later by
 * different agents. A namespace whose dataset file does not exist yet is simply
 * not a target here; it is never an error.
 *
 * Baseline file naming follows what the lexical lane already established:
 * `<mode>.json` for the canonical seed, `<mode>-supplemental.json`, and
 * `<mode>-<namespace>.json` for a per-namespace dataset.
 */

import type { BaselineTarget, MeasuredBaseline } from "./baseline.js";
import { assertDenseMeasurement } from "./dense-measurement.js";
import { assertDenseQualityFloors } from "./dense-quality-floors.js";
import { assertFullDiscoveryCandidates } from "./live-catalog.js";
import { evaluateLexicalDiscovery } from "./lexical-retrieval.js";
import {
  liveEvalNamespaces,
  loadNamespaceDataset,
  namespaceDatasetExists,
  namespaceDatasetId,
  validateNamespaceDataset,
  type NamespaceDataset,
} from "./namespace-dataset.js";
import { toBaselineMetrics } from "./report-metrics.js";
import {
  evaluateDiscoverTools,
  loadDataset,
  validateDatasetExpectedTools,
  validateDatasetPrompts,
  type SeedQuery,
} from "./retrieval-eval-harness.js";
import { SUPPLEMENTAL_DATASET_ID, loadSupplementalDataset } from "./supplemental-dataset.js";

export const CANONICAL_DATASET_ID = "tool-discovery-seed";
export const CANONICAL_DATASET_VERSION = "v3-agent-116";
export const DISCOVERY_LIMIT = 5;

export interface EvalDataset {
  /** Stable id written into the baseline file. */
  datasetId: string;
  /** Human name used in reports. */
  name: string;
  version: string;
  /** Baseline file name minus the mode prefix, e.g. "" | "-supplemental". */
  baselineSuffix: string;
  queries: readonly SeedQuery[];
  /** All dataset-level validation problems, in full. */
  validate: () => string[];
}

function canonicalDataset(): EvalDataset {
  const queries = loadDataset();
  return {
    datasetId: CANONICAL_DATASET_ID,
    name: "canonical seed dataset",
    version: CANONICAL_DATASET_VERSION,
    baselineSuffix: "",
    queries,
    validate: () => [...validateDatasetPrompts(queries), ...validateDatasetExpectedTools(queries)],
  };
}

function supplementalDataset(): EvalDataset {
  const dataset = loadSupplementalDataset();
  return {
    datasetId: SUPPLEMENTAL_DATASET_ID,
    name: "supplemental Pendle+Relay+Virtuals coverage",
    version: dataset.version,
    baselineSuffix: "-supplemental",
    queries: dataset.queries,
    validate: () => [
      ...validateDatasetPrompts(dataset.queries),
      ...validateDatasetExpectedTools(dataset.queries),
    ],
  };
}

export function toEvalDataset(dataset: NamespaceDataset): EvalDataset {
  return {
    datasetId: namespaceDatasetId(dataset.namespace),
    name: `${dataset.namespace} namespace coverage`,
    version: dataset.version,
    baselineSuffix: `-${dataset.namespace}`,
    queries: dataset.queries,
    // The two validators overlap on tool-identity leakage by design; identical
    // problems are reported once.
    validate: () => [...new Set([
      ...validateDatasetPrompts(dataset.queries),
      ...validateNamespaceDataset(dataset),
    ])],
  };
}

/** Namespaces whose dataset file exists right now, in catalog order. */
export function authoredNamespaces(): string[] {
  return liveEvalNamespaces().filter((namespace) => namespaceDatasetExists(namespace));
}

/** Every dataset both lanes evaluate: seed, supplemental, and what exists. */
export function evalDatasets(): EvalDataset[] {
  return [
    canonicalDataset(),
    supplementalDataset(),
    ...authoredNamespaces().map((namespace) => toEvalDataset(loadNamespaceDataset(namespace))),
  ];
}

export function assertDatasetValid(dataset: EvalDataset): void {
  const problems = dataset.validate();
  if (problems.length > 0) {
    throw new Error(
      `Dataset ${dataset.datasetId} has ${problems.length} validation problem(s):\n`
      + problems.map((problem) => `  ${problem}`).join("\n"),
    );
  }
}

/**
 * A lexical target that cannot record a reduced catalog.
 *
 * `buildDiscoveryCandidates()` applies the runtime env availability gate, so a
 * process with an unset `requiresEnv` name scores a smaller catalog and every
 * row whose expected tool was hidden reports a clean zero. The candidate-count
 * assertion runs inside `measure`, which `runBaselineTarget` awaits before it
 * reaches any writer, and it names the target that failed.
 */
export function lexicalTarget(dataset: EvalDataset): BaselineTarget {
  const name = `lexical / ${dataset.name}`;
  return {
    name,
    fileName: `lexical${dataset.baselineSuffix}.json`,
    expectedCaseCount: dataset.queries.length,
    measure: (): MeasuredBaseline => {
      assertDatasetValid(dataset);
      assertFullDiscoveryCandidates(name);
      return {
        mode: "lexical",
        datasetId: dataset.datasetId,
        datasetVersion: dataset.version,
        metrics: toBaselineMetrics(evaluateLexicalDiscovery(dataset.queries, DISCOVERY_LIMIT)),
      };
    },
  };
}

/**
 * A dense target that cannot record a degraded or below-floor capture.
 *
 * All four gates run inside `measure`, which `runBaselineTarget` awaits BEFORE
 * it reaches any writer, so `--update` throws instead of writing:
 * - the dataset validators;
 * - the candidate set this process would score is the full catalog;
 * - every row was a real dense measurement over that catalog;
 * - the measurement clears the shared quality floors.
 *
 * The expected candidate count is NOT taken from the current process env. It
 * comes from the environment-independent live catalog, because an expectation
 * derived from the same reduced env as the observation certifies nothing.
 */
export interface DenseTargetOptions {
  /**
   * The retrieval call. Defaults to the real `evaluateDiscoverTools`; tests
   * inject a scripted evaluator so the gates INSIDE this target (density,
   * candidate count, floors) are exercised through the target itself rather
   * than by calling the assertions by hand beside it.
   */
  evaluate?: typeof evaluateDiscoverTools;
}

export function denseTarget(dataset: EvalDataset, options: DenseTargetOptions = {}): BaselineTarget {
  const name = `dense / ${dataset.name}`;
  const evaluate = options.evaluate ?? evaluateDiscoverTools;
  return {
    name,
    fileName: `dense${dataset.baselineSuffix}.json`,
    expectedCaseCount: dataset.queries.length,
    measure: async (): Promise<MeasuredBaseline> => {
      assertDatasetValid(dataset);
      const expectedCandidateCount = assertFullDiscoveryCandidates(name);
      const report = await evaluate(dataset.queries, DISCOVERY_LIMIT);
      assertDenseMeasurement(report, expectedCandidateCount, name);
      const metrics = toBaselineMetrics(report);
      assertDenseQualityFloors(metrics, name);
      return {
        mode: "dense",
        datasetId: dataset.datasetId,
        datasetVersion: dataset.version,
        metrics,
      };
    },
  };
}

export function lexicalTargets(): BaselineTarget[] {
  return evalDatasets().map(lexicalTarget);
}

/**
 * Every dense target, from the same registry the lexical lane consumes: the
 * canonical seed dataset, the supplemental coverage dataset, and each authored
 * per-namespace dataset. The dense runner used to hand-wire the canonical case
 * and omit the supplemental one entirely, so the two lanes measured different
 * dataset sets while claiming one registry.
 */
export function denseTargets(): BaselineTarget[] {
  // Explicit arrow: `.map(denseTarget)` would pass the array index as the
  // options argument.
  return evalDatasets().map((dataset) => denseTarget(dataset));
}

export function denseNamespaceTargets(): BaselineTarget[] {
  return authoredNamespaces().map((namespace) =>
    denseTarget(toEvalDataset(loadNamespaceDataset(namespace))),
  );
}
