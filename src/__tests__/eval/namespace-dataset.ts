/**
 * Per-namespace retrieval datasets: schema, loader and completeness validator.
 *
 * One file per namespace (`datasets/tool-discovery-<namespace>.json`) so the
 * agents authoring them never edit the same file, and so the frozen seed
 * dataset stays frozen. A file that does not exist is simply not a target: the
 * datasets are authored after this tooling lands, and a missing file must not
 * redden a lane.
 *
 * The row shape is the tolerant supplemental shape (free-form version, at least
 * one row) plus a declared `namespace`. What the tolerant schema does not
 * express is checked by {@link validateNamespaceDataset}, which is where these
 * datasets differ from the seed: a per-namespace dataset exists to prove
 * COVERAGE, so every live tool in the namespace needs a blind and a
 * protocol-aware row, and the expectation must be the exact full toolId. Prefix
 * tolerance would let `morpho.markets` stand in for nineteen different tools
 * and report a hit that names nothing.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import {
  AWARENESS_NAMES,
  INTENT_SHAPES,
  SCENARIOS,
  findCatalogIdentityLeaks,
  liveProtocolManifests,
  type SeedQuery,
} from "./retrieval-eval-harness.js";

const NamespaceQuerySchema = z.object({
  query: z.string().min(1),
  awareness: z.enum(AWARENESS_NAMES),
  scenario: z.enum(SCENARIOS),
  intentShape: z.enum(INTENT_SHAPES),
  expectedToolIds: z.array(z.string().min(1)).min(1),
  expectedCoverageGroups: z.array(z.array(z.string().min(1)).min(1)).min(1),
});

const NamespaceDatasetSchema = z.object({
  version: z.string().min(1),
  namespace: z.string().min(1),
  description: z.string(),
  queries: z.array(NamespaceQuerySchema).min(1),
});

export interface NamespaceDataset {
  namespace: string;
  version: string;
  queries: readonly SeedQuery[];
}

/** Namespaces a per-namespace dataset may declare: those with live tools. */
export function liveEvalNamespaces(): string[] {
  return [...new Set(liveProtocolManifests().map((manifest) => manifest.namespace))].sort();
}

export function isLiveEvalNamespace(value: string): boolean {
  return liveEvalNamespaces().includes(value);
}

export function namespaceDatasetId(namespace: string): string {
  return `tool-discovery-${namespace}`;
}

/**
 * Dataset location, derived from the namespace only. No caller passes a
 * filesystem path: the namespace is validated against the live catalog and the
 * path is built here, so a CLI argument can never point at an arbitrary file.
 */
export function namespaceDatasetPath(namespace: string): string {
  return resolve(import.meta.dirname, "datasets", `${namespaceDatasetId(namespace)}.json`);
}

export function namespaceDatasetExists(namespace: string): boolean {
  return existsSync(namespaceDatasetPath(namespace));
}

export function loadNamespaceDataset(namespace: string): NamespaceDataset {
  if (!isLiveEvalNamespace(namespace)) {
    throw new Error(
      `"${namespace}" is not a live protocol namespace. Live namespaces: ${liveEvalNamespaces().join(", ")}.`,
    );
  }
  const path = namespaceDatasetPath(namespace);
  const raw = readFileSync(path, "utf8");
  const json: unknown = JSON.parse(raw);
  const parsed = NamespaceDatasetSchema.parse(json);
  if (parsed.namespace !== namespace) {
    throw new Error(
      `${path} declares namespace "${parsed.namespace}" but is the dataset file for "${namespace}".`,
    );
  }
  return { namespace: parsed.namespace, version: parsed.version, queries: parsed.queries };
}

/**
 * Every completeness rule a per-namespace dataset must satisfy.
 *
 * Returns ALL violations, in full. The caller decides whether to throw; the
 * list is never shortened, because a dataset author needs every row that has to
 * change, not the first few.
 */
export function validateNamespaceDataset(dataset: NamespaceDataset): string[] {
  const problems: string[] = [];

  if (!isLiveEvalNamespace(dataset.namespace)) {
    problems.push(
      `Declared namespace "${dataset.namespace}" is not a live protocol namespace `
      + `(live: ${liveEvalNamespaces().join(", ")}).`,
    );
    return problems;
  }

  const namespaceToolIds = liveProtocolManifests()
    .filter((manifest) => manifest.namespace === dataset.namespace)
    .map((manifest) => manifest.toolId);
  const allLiveToolIds = new Set(liveProtocolManifests().map((manifest) => manifest.toolId));

  const blindCovered = new Set<string>();
  const protocolAwareCovered = new Set<string>();

  for (const query of dataset.queries) {
    const leaks = findCatalogIdentityLeaks(query.query);
    if (leaks.length > 0) {
      problems.push(`Query names live tool identities (${leaks.join(", ")}): "${query.query}"`);
    }

    const expectedIds = [...query.expectedToolIds, ...query.expectedCoverageGroups.flat()];
    for (const expectedId of expectedIds) {
      if (!allLiveToolIds.has(expectedId)) {
        problems.push(
          `"${query.query}" expects "${expectedId}", which is not the exact toolId of a live tool `
          + "(per-namespace datasets do not accept prefixes).",
        );
        continue;
      }
      if (!namespaceToolIds.includes(expectedId)) {
        problems.push(
          `"${query.query}" expects "${expectedId}", which is outside the declared namespace `
          + `"${dataset.namespace}".`,
        );
      }
    }

    for (const expectedId of query.expectedToolIds) {
      if (!namespaceToolIds.includes(expectedId)) continue;
      if (query.awareness === "blind") blindCovered.add(expectedId);
      else protocolAwareCovered.add(expectedId);
    }
  }

  for (const toolId of namespaceToolIds) {
    if (!blindCovered.has(toolId)) {
      problems.push(`No blind query expects "${toolId}".`);
    }
    if (!protocolAwareCovered.has(toolId)) {
      problems.push(`No protocol-aware query expects "${toolId}".`);
    }
  }

  return problems;
}
