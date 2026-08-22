/**
 * Dense retrieval quality floors, owned once.
 *
 * They used to live as four `expect(...)` calls inside the canonical dense
 * runner, which meant the per-namespace dense targets applied none of them: an
 * `--update` could write a per-namespace baseline well below the quality the
 * canonical lane refuses to record. Floors belong to the DENSE MEASUREMENT, not
 * to one test case, so they live here and every dense target enforces them
 * inside `measure`, before `runBaselineTarget` can reach a writer.
 *
 * The values are unchanged from the 2026-08-03 baseline-tooling work.
 */

import type { BaselineMetrics } from "./baseline.js";

export const RECALL5_OVERALL_FLOOR = 0.95;
export const RECALL5_BLIND_FLOOR = 0.94;
export const RECALL5_PROTOCOL_AWARE_FLOOR = 0.98;
export const MRR5_OVERALL_FLOOR = 0.88;

export interface QualityFloorViolation {
  metric: string;
  measured: number;
  floor: number;
}

/**
 * Every floor a measurement misses, in full.
 *
 * A missing `awareness` block counts as 0 rather than being skipped: a dense
 * capture without the awareness split cannot demonstrate the blind floor, and
 * silently passing it would be the same class of defect as measuring a reduced
 * catalog.
 */
export function findQualityFloorViolations(metrics: BaselineMetrics): QualityFloorViolation[] {
  const checks: QualityFloorViolation[] = [
    { metric: "overall recall@5", measured: metrics.overall.recall5, floor: RECALL5_OVERALL_FLOOR },
    { metric: "overall mrr@5", measured: metrics.overall.mrr5, floor: MRR5_OVERALL_FLOOR },
    {
      metric: "blind recall@5",
      measured: metrics.awareness?.blind.recall5 ?? 0,
      floor: RECALL5_BLIND_FLOOR,
    },
    {
      metric: "protocol-aware recall@5",
      measured: metrics.awareness?.protocolAware.recall5 ?? 0,
      floor: RECALL5_PROTOCOL_AWARE_FLOOR,
    },
  ];
  return checks.filter((check) => check.measured < check.floor);
}

/** Throws unless the measurement clears every floor. Runs before any writer. */
export function assertDenseQualityFloors(metrics: BaselineMetrics, context: string): void {
  const violations = findQualityFloorViolations(metrics);
  if (violations.length === 0) return;

  const lines = [
    `${context}: ${violations.length} dense quality floor(s) missed. `
    + "A below-floor capture is a regression, never a new baseline.",
    "",
    ...violations.map((violation) =>
      `  ${violation.metric}: ${violation.measured} < floor ${violation.floor}`),
  ];
  throw new Error(lines.join("\n"));
}
