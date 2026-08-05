/**
 * Loader for the supplemental retrieval-coverage dataset.
 *
 * Deliberately separate from `loadDataset()`: the canonical seed dataset's
 * contract (count, awareness split, blind/protocol-aware prompt rules) is
 * frozen, and coverage for later namespaces must never be added by editing it.
 * This file shares the seed dataset's QUERY shape — so the whole evaluation
 * and aggregation path is reused unchanged — but not its dataset-level rules.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { AWARENESS_NAMES, INTENT_SHAPES, SCENARIOS, type SeedQuery } from "./retrieval-eval-harness.js";

export const SUPPLEMENTAL_DATASET_ID = "tool-discovery-supplemental";

const SupplementalQuerySchema = z.object({
  query: z.string().min(1),
  awareness: z.enum(AWARENESS_NAMES),
  scenario: z.enum(SCENARIOS),
  intentShape: z.enum(INTENT_SHAPES),
  expectedToolIds: z.array(z.string().min(1)).min(1),
  expectedCoverageGroups: z.array(z.array(z.string().min(1)).min(1)).min(1),
});

const SupplementalDatasetSchema = z.object({
  version: z.string().min(1),
  description: z.string(),
  queries: z.array(SupplementalQuerySchema).min(1),
});

export interface SupplementalDataset {
  version: string;
  queries: readonly SeedQuery[];
}

export function loadSupplementalDataset(): SupplementalDataset {
  const path = resolve(import.meta.dirname, "datasets", "tool-discovery-supplemental.json");
  const raw = readFileSync(path, "utf8");
  const json: unknown = JSON.parse(raw);
  const parsed = SupplementalDatasetSchema.parse(json);
  return { version: parsed.version, queries: parsed.queries };
}
