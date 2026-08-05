/**
 * Public entry point for retrieval-eval baseline tooling.
 *
 * Implementation lives in the sibling `baseline/` folder, one responsibility
 * per file (schema, comparison, mode resolution, file I/O).
 */

export {
  BaselineFileSchema,
  BaselineMetricsSchema,
  MetricSchema,
  RETRIEVAL_MODES,
  type BaselineFile,
  type BaselineMetrics,
  type MeasuredBaseline,
  type Metric,
  type Reconciliation,
  type RetrievalMode,
} from "./baseline/schema.js";

export {
  compareBaseline,
  formatComparison,
  type BaselineComparison,
  type IdentityDrift,
  type MetricDrift,
} from "./baseline/compare.js";

export {
  BASELINE_MODES,
  BASELINE_MODE_ENV,
  resolveBaselineMode,
  type BaselineMode,
} from "./baseline/mode.js";

export {
  runBaselineTarget,
  type BaselineRunOutcome,
  type BaselineTarget,
} from "./baseline/run.js";

export {
  assertEvaluatedCaseCount,
  baselinePath,
  readBaseline,
  writeBaseline,
  type UpdateBaselineInput,
} from "./baseline/store.js";
