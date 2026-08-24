/**
 * Contract tests for per-namespace datasets and the shared target registry.
 *
 * The dataset under test is built in memory from the LIVE catalog rather than
 * from a fixture file: the whole point of the coverage validator is that it
 * tracks the catalog, and a checked-in fixture would freeze a stale copy of it.
 * No file is written; the real `datasets/` folder is never touched.
 */

import { describe, expect, it } from "vitest";
import {
  CANONICAL_DATASET_ID,
  authoredNamespaces,
  denseTarget,
  denseTargets,
  evalDatasets,
  lexicalTarget,
  lexicalTargets,
  toEvalDataset,
} from "./eval-targets.js";
import {
  PINNED_LIVE_CATALOG_TOOL_COUNT,
  expectedCandidateCount,
  liveCatalogToolCount,
} from "./live-catalog.js";
import { SUPPLEMENTAL_DATASET_ID } from "./supplemental-dataset.js";
import {
  isLiveEvalNamespace,
  liveEvalNamespaces,
  namespaceDatasetExists,
  namespaceDatasetId,
  namespaceDatasetPath,
  validateNamespaceDataset,
  type NamespaceDataset,
} from "./namespace-dataset.js";
import { liveProtocolManifests, type SeedQuery } from "./retrieval-eval-harness.js";

/** Smallest live namespace, so a complete dataset is two tools wide. */
const NAMESPACE = "relay";
const namespaceManifests = liveProtocolManifests()
  .filter((manifest) => manifest.namespace === NAMESPACE);

function completeDataset(): NamespaceDataset {
  const queries: SeedQuery[] = [];
  for (const manifest of namespaceManifests) {
    for (const awareness of ["blind", "protocol-aware"] as const) {
      queries.push({
        query: awareness === "blind"
          ? `move USDC to another chain, case ${queries.length}`
          : `use Relay to move USDC to another chain, case ${queries.length}`,
        awareness,
        scenario: "bridge",
        intentShape: "single",
        expectedToolIds: [manifest.toolId],
        expectedCoverageGroups: [[manifest.toolId]],
      });
    }
  }
  return { namespace: NAMESPACE, version: "test-1", queries };
}

describe("live namespace set", () => {
  it("lists exactly the namespaces that own live tools", () => {
    const expected = [...new Set(liveProtocolManifests().map((manifest) => manifest.namespace))].sort();
    expect(liveEvalNamespaces()).toEqual(expected);
    expect(isLiveEvalNamespace(NAMESPACE)).toBe(true);
    expect(isLiveEvalNamespace("polymarket")).toBe(false);
  });

  it("derives the dataset path from the namespace alone", () => {
    expect(namespaceDatasetId(NAMESPACE)).toBe("tool-discovery-relay");
    expect(namespaceDatasetPath(NAMESPACE).endsWith("/datasets/tool-discovery-relay.json")).toBe(true);
  });
});

describe("namespace coverage validator", () => {
  it("accepts a dataset that covers every live tool blind and protocol-aware", () => {
    expect(validateNamespaceDataset(completeDataset())).toEqual([]);
  });

  it("names every uncovered tool when a row is missing", () => {
    const dataset = completeDataset();
    const missing = namespaceManifests[0]?.toolId ?? "";
    const problems = validateNamespaceDataset({
      ...dataset,
      queries: dataset.queries.filter((query) => query.expectedToolIds[0] !== missing),
    });
    expect(problems).toContain(`No blind query expects "${missing}".`);
    expect(problems).toContain(`No protocol-aware query expects "${missing}".`);
  });

  it("rejects a prefix instead of the exact toolId", () => {
    const dataset = completeDataset();
    const exact = namespaceManifests[0]?.toolId ?? "";
    const prefix = exact.split(".").slice(0, 2).join(".");
    const first = dataset.queries[0];
    expect(first).toBeDefined();
    const problems = validateNamespaceDataset({
      ...dataset,
      queries: [
        { ...(first as SeedQuery), expectedToolIds: [prefix], expectedCoverageGroups: [[prefix]] },
        ...dataset.queries.slice(1),
      ],
    });
    expect(problems.some((problem) => problem.includes("do not accept prefixes"))).toBe(true);
  });

  it("rejects an expectation from another namespace", () => {
    const dataset = completeDataset();
    const foreign = liveProtocolManifests()
      .find((manifest) => manifest.namespace !== NAMESPACE)?.toolId ?? "";
    const first = dataset.queries[0];
    const problems = validateNamespaceDataset({
      ...dataset,
      queries: [
        { ...(first as SeedQuery), expectedToolIds: [foreign], expectedCoverageGroups: [[foreign]] },
        ...dataset.queries.slice(1),
      ],
    });
    expect(problems.some((problem) => problem.includes("outside the declared namespace"))).toBe(true);
  });

  it("rejects a query that names a live tool identity", () => {
    const dataset = completeDataset();
    const publicName = namespaceManifests[0]?.publicName ?? "";
    const first = dataset.queries[0];
    const problems = validateNamespaceDataset({
      ...dataset,
      queries: [
        { ...(first as SeedQuery), query: `call ${publicName} for me` },
        ...dataset.queries.slice(1),
      ],
    });
    expect(problems.some((problem) => problem.includes("names live tool identities"))).toBe(true);
  });

  it("rejects a dataset declaring a namespace that owns no live tools", () => {
    const problems = validateNamespaceDataset({ ...completeDataset(), namespace: "polymarket" });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("is not a live protocol namespace");
  });
});

describe("shared target registry", () => {
  it("names baselines per mode and namespace", () => {
    const dataset = toEvalDataset(completeDataset());
    expect(lexicalTarget(dataset).fileName).toBe("lexical-relay.json");
    expect(denseTarget(dataset).fileName).toBe("dense-relay.json");
    expect(lexicalTarget(dataset).expectedCaseCount).toBe(dataset.queries.length);
  });

  /**
   * The registry is what both lanes consume. The dense runner used to hand-wire
   * the canonical dataset and skip the supplemental one, so the two lanes
   * measured different dataset sets while claiming one owner.
   */
  it("covers seed, supplemental and every authored namespace in both lanes", () => {
    const datasets = evalDatasets();
    expect(datasets.map((dataset) => dataset.datasetId)).toContain(CANONICAL_DATASET_ID);
    expect(datasets.map((dataset) => dataset.datasetId)).toContain(SUPPLEMENTAL_DATASET_ID);
    for (const namespace of authoredNamespaces()) {
      expect(datasets.map((dataset) => dataset.datasetId)).toContain(namespaceDatasetId(namespace));
    }

    const lexicalFiles = lexicalTargets().map((target) => target.fileName);
    const denseFiles = denseTargets().map((target) => target.fileName);
    expect(denseFiles.length).toBe(datasets.length);
    expect(denseFiles).toEqual(lexicalFiles.map((file) => file.replace(/^lexical/, "dense")));
    expect(denseFiles).toContain("dense.json");
    expect(denseFiles).toContain("dense-supplemental.json");
  });

  /**
   * The expected candidate count must not come from the current process env.
   *
   * The defect: the dense runner passed `buildDiscoveryCandidates().length`,
   * which the availability gate shrinks, so expected and observed fell to 100
   * together and the assertion certified a catalog missing 34 tools.
   */
  it("derives the expected candidate count from the env-independent catalog", () => {
    const names = [...new Set(
      liveProtocolManifests()
        .map((manifest) => manifest.requiresEnv)
        .filter((name): name is string => name !== undefined),
    )];
    const saved = new Map(names.map((name) => [name, process.env[name]]));
    try {
      for (const name of names) delete process.env[name];
      expect(expectedCandidateCount()).toBe(PINNED_LIVE_CATALOG_TOOL_COUNT);
      expect(liveCatalogToolCount()).toBe(PINNED_LIVE_CATALOG_TOOL_COUNT);
    } finally {
      for (const [name, value] of saved) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  /**
   * A reduced catalog fails the target BY NAME rather than producing a row of
   * clean zeros. This is the assertion `baselines/lexical-solana.json` needed:
   * it was captured with all 68 rows at zero recall because the solana tools
   * were simply absent from the candidate set.
   */
  it("fails a lexical target by name when the candidate set is reduced", () => {
    const names = [...new Set(
      liveProtocolManifests()
        .map((manifest) => manifest.requiresEnv)
        .filter((name): name is string => name !== undefined),
    )];
    expect(names.length).toBeGreaterThan(0);
    const saved = new Map(names.map((name) => [name, process.env[name]]));
    try {
      for (const name of names) delete process.env[name];
      const target = lexicalTarget(toEvalDataset(completeDataset()));
      expect(() => target.measure()).toThrow(/lexical \/ relay namespace coverage/);
      expect(() => target.measure()).toThrow(/discovery would score/);
    } finally {
      for (const [name, value] of saved) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  /**
   * A namespace dataset that has not been authored yet is not a target and not
   * an error. This is what lets the tooling land before the datasets do.
   */
  it("treats a missing dataset file as no target at all", () => {
    for (const namespace of liveEvalNamespaces()) {
      if (namespaceDatasetExists(namespace)) continue;
      expect(authoredNamespaces()).not.toContain(namespace);
    }
  });
});
