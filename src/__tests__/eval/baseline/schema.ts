/**
 * Retrieval-eval baseline file contract.
 *
 * One schema serves both retrieval modes and both datasets. The breakdown
 * sections (`awareness`, `intentShapes`, `scenarios`) are OPTIONAL because the
 * canonical 116-query seed dataset carries that curated taxonomy while the
 * supplemental coverage dataset deliberately does not.
 *
 * Tolerant-reader split (project rule 90): fields the comparison CONSUMES
 * (`mode`, `datasetVersion`, `metrics`) are strict; provenance metadata
 * (`capturedAt`, `notes`, `reconciliation`, and `datasetId` on files written
 * before it existed) is tolerant, so a legacy baseline still parses and can be
 * diagnosed by name instead of failing as an opaque parse error.
 */

import { z } from "zod";

export const RETRIEVAL_MODES = ["lexical", "dense"] as const;
export type RetrievalMode = (typeof RETRIEVAL_MODES)[number];

export const MetricSchema = z.object({
  count: z.number().int().nonnegative(),
  recall1: z.number().min(0).max(1),
  recall5: z.number().min(0).max(1),
  coverage5: z.number().min(0).max(1),
  mrr5: z.number().min(0).max(1),
  groupMrr5: z.number().min(0).max(1),
});
export type Metric = z.infer<typeof MetricSchema>;

export const AwarenessMetricsSchema = z.object({
  blind: MetricSchema,
  protocolAware: MetricSchema,
});

export const IntentShapeMetricsSchema = z.object({
  single: MetricSchema,
  cross: MetricSchema,
  compare: MetricSchema,
  workflow: MetricSchema,
});

export const BaselineMetricsSchema = z.object({
  overall: MetricSchema,
  awareness: AwarenessMetricsSchema.optional(),
  intentShapes: IntentShapeMetricsSchema.optional(),
  scenarios: z.record(z.string(), MetricSchema).optional(),
});
export type BaselineMetrics = z.infer<typeof BaselineMetricsSchema>;

/**
 * Why a baseline's numbers moved without the retrieval implementation being at
 * fault — recorded on the file so a later session does not have to reconstruct
 * it from git archaeology (the exact failure this tooling exists to end).
 */
export const ReconciliationSchema = z.object({
  reconciledAt: z.string().min(1),
  previousVersion: z.string().min(1),
  previousCaseCount: z.number().int().nonnegative(),
  reason: z.string().min(1),
});
export type Reconciliation = z.infer<typeof ReconciliationSchema>;

export const BaselineFileSchema = z.object({
  version: z.string().min(1),
  mode: z.enum(RETRIEVAL_MODES),
  datasetId: z.string().min(1).optional(),
  datasetVersion: z.string().min(1),
  status: z.literal("captured"),
  capturedAt: z.string().min(1),
  metrics: BaselineMetricsSchema,
  notes: z.array(z.string()).optional(),
  reconciliation: ReconciliationSchema.optional(),
});
export type BaselineFile = z.infer<typeof BaselineFileSchema>;

/**
 * The measured half of a run: everything a `--check` compares, with no
 * timestamp and no provenance prose. Keeping this separate from
 * `BaselineFile` is what makes `--check` byte-stable — there is no field a
 * check could be tempted to refresh.
 */
export interface MeasuredBaseline {
  mode: RetrievalMode;
  datasetId: string;
  datasetVersion: string;
  metrics: BaselineMetrics;
}
