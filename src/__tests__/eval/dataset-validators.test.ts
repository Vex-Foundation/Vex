/**
 * Contract tests for the dataset validators.
 *
 * The acceptance the validators exist for: the FROZEN seed dataset and the
 * supplemental dataset must keep validating without edits, a protocol-aware
 * pools.fun query must be expressible, and an exact live tool identity inside a
 * query must fail. Before this revision the brand regex knew five protocols and
 * the internal-naming rule rejected every dotted token, which made "pools.fun"
 * unwritable and let seven namespaces be named in a supposedly blind query.
 */

import { describe, expect, it } from "vitest";
import { loadSupplementalDataset } from "./supplemental-dataset.js";
import {
  findCatalogIdentityLeaks,
  liveProtocolManifests,
  loadDataset,
  validateDatasetExpectedTools,
  validateDatasetPrompts,
  type SeedQuery,
} from "./retrieval-eval-harness.js";

const poolsManifest = liveProtocolManifests().find((manifest) => manifest.namespace === "pools");
const morphoManifest = liveProtocolManifests().find((manifest) => manifest.namespace === "morpho");
const anyLiveToolId = liveProtocolManifests()[0]?.toolId ?? "";

function row(overrides: Partial<SeedQuery>): SeedQuery {
  return {
    query: "swap tokens",
    awareness: "blind",
    scenario: "evm_swap",
    intentShape: "single",
    expectedToolIds: [anyLiveToolId],
    expectedCoverageGroups: [[anyLiveToolId]],
    ...overrides,
  };
}

describe("frozen datasets under the revised validators", () => {
  it("validates the canonical seed dataset without edits", () => {
    const queries = loadDataset();
    expect(validateDatasetPrompts(queries)).toEqual([]);
    expect(validateDatasetExpectedTools(queries)).toEqual([]);
  });

  it("validates the supplemental dataset without edits", () => {
    const dataset = loadSupplementalDataset();
    expect(validateDatasetPrompts(dataset.queries)).toEqual([]);
    expect(validateDatasetExpectedTools(dataset.queries)).toEqual([]);
  });

  /**
   * Twelve frozen blind rows use Solana as a CHAIN word. Solana is therefore
   * not a brand for this rule; Jupiter is the protocol-aware term for the
   * `solana` namespace.
   */
  it("keeps Solana usable as a chain word in a blind query", () => {
    expect(validateDatasetPrompts([row({ query: "find yield rates for lending USDC on Solana" })]))
      .toEqual([]);
  });
});

describe("brand rules", () => {
  it("accepts a protocol-aware pools.fun query", () => {
    expect(poolsManifest).toBeDefined();
    const problems = validateDatasetPrompts([
      row({
        query: "launch a token on pools.fun",
        awareness: "protocol-aware",
        expectedToolIds: [poolsManifest?.toolId ?? ""],
        expectedCoverageGroups: [[poolsManifest?.toolId ?? ""]],
      }),
    ]);
    expect(problems).toEqual([]);
  });

  it("rejects a blind query that names a newly recognised protocol", () => {
    const problems = validateDatasetPrompts([row({ query: "supply collateral on Morpho" })]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("Blind query leaks protocol name");
  });

  it("rejects a protocol-aware query that names no protocol", () => {
    const problems = validateDatasetPrompts([
      row({ query: "supply collateral to a lending market", awareness: "protocol-aware" }),
    ]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("does not name a protocol");
  });
});

describe("catalog identity leak check", () => {
  it("rejects a query containing an exact live toolId", () => {
    expect(morphoManifest).toBeDefined();
    const toolId = morphoManifest?.toolId ?? "";
    expect(findCatalogIdentityLeaks(`please call ${toolId}.`)).toEqual([toolId]);
    const problems = validateDatasetPrompts([
      row({ query: `use Morpho, call ${toolId}`, awareness: "protocol-aware" }),
    ]);
    expect(problems.some((problem) => problem.includes("names live tool identities"))).toBe(true);
  });

  it("rejects a query containing an exact live publicName", () => {
    const publicName = morphoManifest?.publicName ?? "";
    expect(findCatalogIdentityLeaks(`run ${publicName} now`)).toEqual([publicName.toLowerCase()]);
  });

  it("does not treat the pools.fun brand as a tool identity", () => {
    expect(findCatalogIdentityLeaks("launch a token on pools.fun")).toEqual([]);
  });
});
