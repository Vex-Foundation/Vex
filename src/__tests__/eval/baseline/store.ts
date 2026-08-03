/**
 * Baseline file I/O and the case-count assertion.
 *
 * Serialization is canonical (fixed key order, two-space indent, trailing
 * newline) so an `--update` that measures identical numbers produces an
 * identical file except for its provenance fields.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  BaselineFileSchema,
  type BaselineFile,
  type MeasuredBaseline,
  type Reconciliation,
} from "./schema.js";

export function baselinePath(fileName: string): string {
  return resolve(import.meta.dirname, "..", "baselines", fileName);
}

/**
 * Reads a baseline. A MISSING file returns `null` (the caller decides whether
 * that is a first capture or a check failure); a present but INVALID file
 * throws by name rather than being silently treated as absent.
 */
export function readBaseline(path: string): BaselineFile | null {
  if (!existsSync(path)) return null;

  const raw = readFileSync(path, "utf8");
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Baseline ${path} is not valid JSON.`, { cause: err });
  }

  const parsed = BaselineFileSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(
      `Baseline ${path} does not match the baseline contract: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ")}`,
    );
  }
  return parsed.data;
}

export interface UpdateBaselineInput {
  measured: MeasuredBaseline;
  notes?: readonly string[];
  reconciliation?: Reconciliation;
}

/** The ONLY writer. Reachable exclusively from an explicit `--update`. */
export function writeBaseline(path: string, input: UpdateBaselineInput): BaselineFile {
  const file: BaselineFile = {
    version: input.measured.datasetVersion,
    mode: input.measured.mode,
    datasetId: input.measured.datasetId,
    datasetVersion: input.measured.datasetVersion,
    status: "captured",
    capturedAt: new Date().toISOString(),
    metrics: input.measured.metrics,
    ...(input.notes && input.notes.length > 0 ? { notes: [...input.notes] } : {}),
    ...(input.reconciliation ? { reconciliation: input.reconciliation } : {}),
  };

  const validated = BaselineFileSchema.parse(file);
  writeFileSync(path, `${JSON.stringify(validated, null, 2)}\n`, "utf8");
  return validated;
}

/**
 * A run that evaluated nothing is a FAILURE, never a pass.
 *
 * The failure mode this closes: a dense eval whose embedding endpoint or
 * credentials are absent evaluates zero cases, aggregates to all-zero metrics,
 * and reports green. Zero cases is not evidence of anything.
 */
export function assertEvaluatedCaseCount(
  evaluatedCount: number,
  expectedCount: number,
  context: string,
): void {
  if (evaluatedCount === 0) {
    throw new Error(
      `${context}: evaluated 0 of ${expectedCount} cases. A retrieval eval that evaluates `
      + "nothing is a FAILURE, not a skip — the usual cause is a missing embedding endpoint, "
      + "missing credentials, or an empty dataset. Bring the dependency up and re-run.",
    );
  }
  if (evaluatedCount !== expectedCount) {
    throw new Error(
      `${context}: evaluated ${evaluatedCount} of ${expectedCount} cases. Every dataset case `
      + "must be evaluated for the metrics to be comparable against a baseline.",
    );
  }
}
