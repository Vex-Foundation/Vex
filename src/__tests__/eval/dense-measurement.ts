/**
 * The gate that decides whether a dense run MEASURED anything.
 *
 * `dense-score.ts` degrades to lexical on an empty result or any throw and
 * reports the degradation only through `retrieval.method` / `denseFailed`. A
 * degraded run still produces complete-looking metrics, so without this check
 * a `--update` can record a lexical fallback as the dense baseline, and a probe
 * run can report recall for a catalog that silently shrank (an unset
 * `requiresEnv` removes its tools from the candidate set before scoring).
 *
 * Therefore every caller asserts, BEFORE any baseline writer and before any
 * quality floor, that every row was dense, no row fell back, and every row saw
 * the same expected candidate count.
 *
 * Violations are reported in FULL. A truncated list hides exactly the rows an
 * operator needs to diagnose the degradation.
 */

import type { ModeReport, QueryResult } from "./retrieval-eval-harness.js";

export interface DenseMeasurementViolation {
  query: string;
  retrievalMethod: string | undefined;
  denseFailed: boolean;
  candidateCount: number | undefined;
  topIds: readonly string[];
}

export function findDenseMeasurementViolations(
  results: readonly QueryResult[],
  expectedCandidateCount: number,
): DenseMeasurementViolation[] {
  const violations: DenseMeasurementViolation[] = [];
  for (const result of results) {
    const wrongMethod = result.retrievalMethod !== "dense";
    const fellBack = result.denseFailed;
    const wrongCandidates = result.candidateCount !== expectedCandidateCount;
    if (wrongMethod || fellBack || wrongCandidates) {
      violations.push({
        query: result.query.query,
        retrievalMethod: result.retrievalMethod,
        denseFailed: result.denseFailed,
        candidateCount: result.candidateCount,
        topIds: result.topIds,
      });
    }
  }
  return violations;
}

export function formatDenseMeasurementViolations(
  violations: readonly DenseMeasurementViolation[],
  expectedCandidateCount: number,
  context: string,
): string {
  const lines = [
    `${context}: ${violations.length} row(s) are not a valid dense measurement `
    + `(required: retrievalMethod "dense", denseFailed false, candidateCount ${expectedCandidateCount}).`,
    "A lexical fallback or a reduced candidate set is a FAILED measurement, never a result.",
    "",
  ];
  for (const violation of violations) {
    lines.push(
      `  query: ${violation.query}`,
      `    retrievalMethod: ${String(violation.retrievalMethod)}`,
      `    denseFailed: ${String(violation.denseFailed)}`,
      `    candidateCount: ${String(violation.candidateCount)} (expected ${expectedCandidateCount})`,
      `    topIds: ${violation.topIds.join(", ")}`,
    );
  }
  return lines.join("\n");
}

/**
 * Throws unless every row of the report is a valid dense measurement.
 *
 * An EMPTY report also throws: zero evaluated rows is not evidence of anything.
 */
export function assertDenseMeasurement(
  report: ModeReport,
  expectedCandidateCount: number,
  context = "dense measurement",
): void {
  if (report.results.length === 0) {
    throw new Error(`${context}: evaluated 0 rows. A dense eval that measures nothing is a FAILURE.`);
  }
  const violations = findDenseMeasurementViolations(report.results, expectedCandidateCount);
  if (violations.length > 0) {
    throw new Error(formatDenseMeasurementViolations(violations, expectedCandidateCount, context));
  }
}
