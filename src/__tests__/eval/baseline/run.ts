/**
 * The check/update execution path, shared by every retrieval mode.
 *
 * Invariants this function exists to guarantee:
 * - `--check` NEVER writes. Not the metrics, not the timestamp, not a note.
 * - a run that evaluated zero cases FAILS by name before any comparison.
 * - `--update` is the only writer, and it records WHY the numbers moved
 *   (measured delta, dataset version, and a reconciliation block when the
 *   previous baseline was captured against a different dataset).
 */

import { compareBaseline, formatComparison } from "./compare.js";
import type { BaselineMode } from "./mode.js";
import type { BaselineFile, MeasuredBaseline, Reconciliation } from "./schema.js";
import { assertEvaluatedCaseCount, baselinePath, readBaseline, writeBaseline } from "./store.js";

export interface BaselineTarget {
  /** Human name used in reports, e.g. "lexical / canonical seed dataset". */
  name: string;
  /** File name inside `src/__tests__/eval/baselines/`. */
  fileName: string;
  expectedCaseCount: number;
  measure: () => MeasuredBaseline | Promise<MeasuredBaseline>;
  /**
   * Absolute override for the baseline location. Exists so the tooling's own
   * tests can exercise this exact function against a temp file instead of
   * reimplementing its dispatch — and so they can never write into the
   * repository's real baselines.
   */
  path?: string;
}

export interface BaselineRunOutcome {
  ok: boolean;
  report: string;
  measured: MeasuredBaseline;
}

export async function runBaselineTarget(
  target: BaselineTarget,
  mode: BaselineMode,
): Promise<BaselineRunOutcome> {
  const measured = await target.measure();
  assertEvaluatedCaseCount(
    measured.metrics.overall.count,
    target.expectedCaseCount,
    `${target.name} (${measured.datasetId})`,
  );

  const path = target.path ?? baselinePath(target.fileName);
  const existing = readBaseline(path);

  if (mode === "update") {
    return { ok: true, report: updateBaseline(target, measured, path, existing), measured };
  }

  if (existing === null) {
    return {
      ok: false,
      measured,
      report: `${target.name}: no baseline at ${path}. Capture one with --update before --check can gate anything.`,
    };
  }

  const comparison = compareBaseline(existing, measured);
  return {
    ok: comparison.ok,
    measured,
    report: `${target.name}\n${formatComparison(comparison, path)}`,
  };
}

function updateBaseline(
  target: BaselineTarget,
  measured: MeasuredBaseline,
  path: string,
  existing: BaselineFile | null,
): string {
  const notes = buildDeltaNotes(measured, existing);
  const reconciliation = buildReconciliation(measured, existing);
  writeBaseline(path, { measured, notes, ...(reconciliation ? { reconciliation } : {}) });

  return [
    `${target.name}: baseline UPDATED at ${path}.`,
    ...notes.map((note) => `  ${note}`),
    ...(reconciliation ? [`  reconciliation: ${reconciliation.reason}`] : []),
  ].join("\n");
}

function buildDeltaNotes(
  measured: MeasuredBaseline,
  existing: BaselineFile | null,
): string[] {
  const overall = measured.metrics.overall;
  const notes = [
    `dataset ${measured.datasetId}@${measured.datasetVersion}, mode ${measured.mode}, ${overall.count} cases evaluated.`,
    `overall recall@1 ${overall.recall1}, recall@5 ${overall.recall5}, coverage@5 ${overall.coverage5}, mrr@5 ${overall.mrr5}, groupMrr@5 ${overall.groupMrr5}.`,
  ];

  if (existing === null) {
    notes.push("First capture — no previous baseline to measure a delta against.");
    return notes;
  }

  const comparison = compareBaseline(existing, measured);
  if (comparison.ok) {
    notes.push("Measured delta: none — metrics are identical to the previous baseline.");
    return notes;
  }

  const previous = existing.metrics.overall;
  notes.push(
    `Measured delta vs previous baseline (${existing.datasetVersion}, captured ${existing.capturedAt}): `
    + `${comparison.metricDrift.length} metric values moved; `
    + `overall recall@5 ${previous.recall5} -> ${overall.recall5}, `
    + `overall mrr@5 ${previous.mrr5} -> ${overall.mrr5}, `
    + `case count ${previous.count} -> ${overall.count}.`,
  );
  return notes;
}

function buildReconciliation(
  measured: MeasuredBaseline,
  existing: BaselineFile | null,
): Reconciliation | undefined {
  if (existing === null || existing.datasetVersion === measured.datasetVersion) return undefined;

  return {
    reconciledAt: new Date().toISOString(),
    previousVersion: existing.datasetVersion,
    previousCaseCount: existing.metrics.overall.count,
    reason:
      `Previous baseline was captured against dataset ${existing.datasetVersion} `
      + `(${existing.metrics.overall.count} cases) on ${existing.capturedAt}; the canonical dataset is now `
      + `${measured.datasetVersion} (${measured.metrics.overall.count} cases). The baseline was STALE — it was `
      + "never recaptured after the dataset changed — so this update re-anchors it against the current dataset. "
      + "The dataset contract and its quality floors were NOT changed.",
  };
}
