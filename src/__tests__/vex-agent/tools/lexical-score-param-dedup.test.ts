/**
 * Regression for the param-count scoring bias found by the 2026-08-18 audit.
 *
 * Param fields come in pairs per parameter (key + description), so before the
 * fix a query token appearing in N param descriptions scored N times and a
 * tool's lexical score grew with its parameter COUNT: adding six filters to
 * `morpho.markets.discover` lifted it above `khalani.quote.get` on
 * "bridge usdc to base" (176 vs 129) purely on filler-token stacking.
 *
 * The contract pinned here: a query token is credited at most once across the
 * whole params family, so duplicating a tool's params must not change its
 * score, and a bridge intent must keep ranking the bridge tools above a
 * lending screener that merely has many parameters.
 */

import { describe, expect, it } from "vitest";

import { PROTOCOL_TOOLS } from "../../../vex-agent/tools/protocols/catalog.js";
import { lexicalScore } from "../../../vex-agent/tools/protocols/lexical-score.js";
import type { ProtocolToolManifest } from "../../../vex-agent/tools/protocols/types.js";

function mustFindManifest(toolId: string): ProtocolToolManifest {
  const manifest = PROTOCOL_TOOLS.find((tool) => tool.toolId === toolId);
  if (manifest === undefined) throw new Error(`manifest not in catalog: ${toolId}`);
  return manifest;
}

describe("lexical score param-family dedup", () => {
  it("duplicating a tool's params does not change its score", () => {
    const manifest = mustFindManifest("morpho.markets.discover");
    const doubled: ProtocolToolManifest = {
      ...manifest,
      params: [...manifest.params, ...manifest.params],
    };
    const query = "bridge usdc to base";
    const baseline = lexicalScore(query, [manifest]).scored[0];
    const inflated = lexicalScore(query, [doubled]).scored[0];
    expect(baseline, "baseline manifest should score at all").toBeDefined();
    expect(inflated?.score).toBe(baseline?.score);
  });

  it("'bridge usdc to base' ranks a khalani bridge tool above the morpho market screener", () => {
    const outcome = lexicalScore("bridge usdc to base", [...PROTOCOL_TOOLS]);
    const rankOf = (prefix: string): number =>
      outcome.scored.findIndex((entry) => entry.manifest.toolId.startsWith(prefix));
    const khalaniRank = rankOf("khalani.");
    const morphoScreenerRank = rankOf("morpho.markets.discover");
    expect(khalaniRank, "a khalani tool must match the bridge intent").toBeGreaterThanOrEqual(0);
    if (morphoScreenerRank >= 0) {
      expect(khalaniRank).toBeLessThan(morphoScreenerRank);
    }
  });
});
