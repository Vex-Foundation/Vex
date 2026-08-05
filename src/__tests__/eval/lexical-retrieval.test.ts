/**
 * Contract tests for the lexical eval lane and the supplemental dataset.
 *
 * Stack-free and deterministic, so they run in the default `pnpm test`. The
 * baseline COMPARISON itself is deliberately not here — it lives behind
 * `pnpm test:eval:lexical`, so a pending baseline recapture cannot redden the
 * default suite for unrelated work.
 */

import { describe, expect, it } from "vitest";
import {
  PROTOCOL_TOOLS,
  isAdvertisedProtocolNamespace,
} from "../../vex-agent/tools/protocols/catalog.js";
import { discoverProtocolCapabilities } from "../../vex-agent/tools/protocols/runtime.js";
import { buildDiscoveryCandidates, evaluateLexicalDiscovery, lexicalTopIds } from "./lexical-retrieval.js";
import { loadDataset, validateDatasetExpectedTools } from "./retrieval-eval-harness.js";
import { loadSupplementalDataset } from "./supplemental-dataset.js";
import { toBaselineMetrics } from "./report-metrics.js";

const candidates = buildDiscoveryCandidates();
const supplemental = loadSupplementalDataset();

describe("lexical eval candidate set", () => {
  it("matches the candidate set discover_tools itself reports", async () => {
    // The eval rebuilds this filter because `discovery.ts` keeps it private.
    // This assertion is what stops that duplicate from silently diverging.
    const result = await discoverProtocolCapabilities({ limit: 1 });
    expect(result.success).toBe(true);
    expect(result.retrieval?.candidateCount).toBe(candidates.length);
  });

  it("is non-empty and free of unadvertised namespaces", () => {
    expect(candidates.length).toBeGreaterThan(0);
    const unadvertised = candidates
      .filter((manifest) => !isAdvertisedProtocolNamespace(manifest.namespace))
      .map((manifest) => manifest.toolId);
    expect(unadvertised).toEqual([]);
  });

  /**
   * Uniswap coverage, pinned as the contract that actually holds: `uniswap` is
   * not an advertised namespace, so discovery can never return its manifests.
   * A retrieval expectation for them would be unreachable by construction — if
   * that ever changes, this test fails and the supplemental dataset should gain
   * real Uniswap queries.
   */
  it("excludes Uniswap because its namespace is not advertised", () => {
    const uniswapTools = PROTOCOL_TOOLS.filter((manifest) => manifest.namespace === "uniswap");
    expect(uniswapTools.length).toBeGreaterThan(0);
    expect(isAdvertisedProtocolNamespace("uniswap")).toBe(false);
    expect(candidates.filter((manifest) => manifest.namespace === "uniswap")).toEqual([]);
    expect(lexicalTopIds("Swap tokens on Uniswap", 5, candidates)
      .filter((toolId) => toolId.startsWith("uniswap."))).toEqual([]);
  });
});

describe("lexical retrieval determinism", () => {
  it("returns identical rankings across runs", () => {
    const first = lexicalTopIds("Claim my Pendle rewards", 5, candidates);
    const second = lexicalTopIds("Claim my Pendle rewards", 5, candidates);
    expect(second).toEqual(first);
    expect(first.length).toBeGreaterThan(0);
  });

  it("evaluates every canonical seed case", () => {
    const report = evaluateLexicalDiscovery(loadDataset(), 5);
    expect(toBaselineMetrics(report).overall.count).toBe(loadDataset().length);
  });
});

describe("supplemental retrieval dataset", () => {
  it("is a separate file that does not touch the canonical dataset contract", () => {
    expect(supplemental.version).toBe("supplemental-v1");
    expect(loadDataset()).toHaveLength(116);
  });

  it("references only active, advertised tool IDs", () => {
    expect(validateDatasetExpectedTools(supplemental.queries)).toEqual([]);
  });

  it("covers Pendle, Relay and Virtuals", () => {
    const namespaces = new Set(
      supplemental.queries.flatMap((query) =>
        query.expectedToolIds.map((toolId) => toolId.split(".")[0]),
      ),
    );
    expect([...namespaces].sort()).toEqual(["pendle", "relay", "virtuals"]);
  });

  it("evaluates every supplemental case", () => {
    const report = evaluateLexicalDiscovery(supplemental.queries, 5);
    expect(toBaselineMetrics(report).overall.count).toBe(supplemental.queries.length);
  });
});
