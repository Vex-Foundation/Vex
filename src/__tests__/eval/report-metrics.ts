/**
 * Projects a `ModeReport` into the typed, three-decimal `BaselineMetrics`
 * shape that baselines store and `--check` compares.
 *
 * Rounding happens HERE, once, for both retrieval modes — a baseline and a
 * measurement must be rounded identically or exact comparison is meaningless.
 */

import { SCENARIOS, round3, type Metrics, type ModeReport } from "./retrieval-eval-harness.js";
import type { BaselineMetrics, Metric } from "./baseline.js";

export function toBaselineMetrics(report: ModeReport): BaselineMetrics {
  return {
    overall: compactMetric(report.metrics.overall),
    awareness: {
      blind: compactMetric(report.metrics.awareness.blind),
      protocolAware: compactMetric(report.metrics.awareness["protocol-aware"]),
    },
    intentShapes: {
      single: compactMetric(report.metrics.intentShapes.single),
      cross: compactMetric(report.metrics.intentShapes.cross),
      compare: compactMetric(report.metrics.intentShapes.compare),
      workflow: compactMetric(report.metrics.intentShapes.workflow),
    },
    scenarios: Object.fromEntries(
      SCENARIOS.map((scenario) => [scenario, compactMetric(report.metrics.scenarios[scenario])]),
    ),
  };
}

/** Overall-only projection, for datasets without the curated taxonomy. */
export function toOverallBaselineMetrics(metrics: Metrics): BaselineMetrics {
  return { overall: compactMetric(metrics) };
}

export function compactMetric(metrics: Metrics): Metric {
  return {
    count: metrics.count,
    recall1: round3(metrics.recall1),
    recall5: round3(metrics.recall5),
    coverage5: round3(metrics.coverage5),
    mrr5: round3(metrics.mrr5),
    groupMrr5: round3(metrics.groupMrr5),
  };
}
