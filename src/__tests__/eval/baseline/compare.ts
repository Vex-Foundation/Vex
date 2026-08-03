/**
 * Deterministic baseline comparison for `--check`.
 *
 * Exact equality, no tolerance. Both sides are already rounded to three
 * decimals by `round3` before they reach here, so equality is well-defined; a
 * tolerance would only hide the regressions this gate exists to catch.
 *
 * `capturedAt`, `notes` and `reconciliation` are provenance, not measurements,
 * and are deliberately OUTSIDE the compared surface — that is what lets a
 * check run without rewriting a single byte of the baseline file.
 */

import type { BaselineFile, BaselineMetrics, MeasuredBaseline, Metric } from "./schema.js";

const METRIC_KEYS = ["count", "recall1", "recall5", "coverage5", "mrr5", "groupMrr5"] as const;

export interface MetricDrift {
  path: string;
  baseline: number;
  measured: number;
  delta: number;
}

export interface IdentityDrift {
  field: string;
  baseline: string;
  measured: string;
}

export interface BaselineComparison {
  ok: boolean;
  identityDrift: IdentityDrift[];
  metricDrift: MetricDrift[];
  structuralProblems: string[];
}

export function compareBaseline(
  baseline: BaselineFile,
  measured: MeasuredBaseline,
): BaselineComparison {
  const identityDrift = compareIdentity(baseline, measured);
  const structuralProblems: string[] = [];
  const metricDrift: MetricDrift[] = [];

  compareMetrics(baseline.metrics, measured.metrics, metricDrift, structuralProblems);

  return {
    ok: identityDrift.length === 0
      && metricDrift.length === 0
      && structuralProblems.length === 0,
    identityDrift,
    metricDrift,
    structuralProblems,
  };
}

/**
 * Human-readable drift report. Identity drift is rendered FIRST and on its own,
 * because a dataset-version mismatch makes every metric line downstream noise
 * rather than a regression signal.
 */
export function formatComparison(
  comparison: BaselineComparison,
  baselinePath: string,
): string {
  if (comparison.ok) {
    return `Baseline check PASSED — measured metrics are identical to ${baselinePath}.`;
  }

  const lines: string[] = [`Baseline check FAILED against ${baselinePath}.`];

  if (comparison.identityDrift.length > 0) {
    lines.push("", "Identity drift (the baseline was captured against a different contract):");
    for (const drift of comparison.identityDrift) {
      lines.push(`  ${drift.field}: baseline "${drift.baseline}" vs measured "${drift.measured}"`);
    }
    lines.push(
      "",
      "The stored baseline does not describe the dataset that was just evaluated;",
      "metric comparison below is NOT a regression signal until this is reconciled",
      "with an explicit --update.",
    );
  }

  if (comparison.structuralProblems.length > 0) {
    lines.push("", "Structural problems:");
    for (const problem of comparison.structuralProblems) lines.push(`  ${problem}`);
  }

  if (comparison.metricDrift.length > 0) {
    lines.push("", `Metric drift (${comparison.metricDrift.length} values moved):`);
    for (const drift of comparison.metricDrift) {
      const sign = drift.delta > 0 ? "+" : "";
      lines.push(
        `  ${drift.path}: ${drift.baseline} -> ${drift.measured} (${sign}${round3(drift.delta)})`,
      );
    }
  }

  lines.push(
    "",
    "If this movement is intended, re-run with --update to record it (the measured",
    "delta and dataset version are written into the baseline's metadata).",
  );

  return lines.join("\n");
}

function compareIdentity(baseline: BaselineFile, measured: MeasuredBaseline): IdentityDrift[] {
  const drift: IdentityDrift[] = [];

  if (baseline.mode !== measured.mode) {
    drift.push({ field: "mode", baseline: baseline.mode, measured: measured.mode });
  }
  if (baseline.datasetVersion !== measured.datasetVersion) {
    drift.push({
      field: "datasetVersion",
      baseline: baseline.datasetVersion,
      measured: measured.datasetVersion,
    });
  }
  // Absent on baselines written before `datasetId` existed; only a PRESENT and
  // different id is drift (tolerant reader on provenance).
  if (baseline.datasetId !== undefined && baseline.datasetId !== measured.datasetId) {
    drift.push({
      field: "datasetId",
      baseline: baseline.datasetId,
      measured: measured.datasetId,
    });
  }

  return drift;
}

function compareMetrics(
  baseline: BaselineMetrics,
  measured: BaselineMetrics,
  metricDrift: MetricDrift[],
  structuralProblems: string[],
): void {
  compareMetric("overall", baseline.overall, measured.overall, metricDrift);

  compareSection(
    "awareness",
    baseline.awareness,
    measured.awareness,
    metricDrift,
    structuralProblems,
  );
  compareSection(
    "intentShapes",
    baseline.intentShapes,
    measured.intentShapes,
    metricDrift,
    structuralProblems,
  );
  compareSection(
    "scenarios",
    baseline.scenarios,
    measured.scenarios,
    metricDrift,
    structuralProblems,
  );
}

function compareSection(
  section: string,
  baseline: Record<string, Metric> | undefined,
  measured: Record<string, Metric> | undefined,
  metricDrift: MetricDrift[],
  structuralProblems: string[],
): void {
  if (baseline === undefined && measured === undefined) return;
  if (baseline === undefined) {
    structuralProblems.push(`section "${section}" is measured but absent from the baseline`);
    return;
  }
  if (measured === undefined) {
    structuralProblems.push(`section "${section}" is in the baseline but was not measured`);
    return;
  }

  for (const key of sortedKeys(baseline, measured)) {
    const baselineMetric = baseline[key];
    const measuredMetric = measured[key];
    if (baselineMetric === undefined) {
      structuralProblems.push(`"${section}.${key}" is measured but absent from the baseline`);
      continue;
    }
    if (measuredMetric === undefined) {
      structuralProblems.push(`"${section}.${key}" is in the baseline but was not measured`);
      continue;
    }
    compareMetric(`${section}.${key}`, baselineMetric, measuredMetric, metricDrift);
  }
}

function compareMetric(
  path: string,
  baseline: Metric,
  measured: Metric,
  metricDrift: MetricDrift[],
): void {
  for (const key of METRIC_KEYS) {
    const baselineValue = baseline[key];
    const measuredValue = measured[key];
    if (baselineValue !== measuredValue) {
      metricDrift.push({
        path: `${path}.${key}`,
        baseline: baselineValue,
        measured: measuredValue,
        delta: measuredValue - baselineValue,
      });
    }
  }
}

function sortedKeys(
  baseline: Record<string, Metric>,
  measured: Record<string, Metric>,
): string[] {
  return [...new Set([...Object.keys(baseline), ...Object.keys(measured)])].sort();
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
