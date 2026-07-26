/**
 * discover_tools v3 dataset contract.
 *
 * This file is intentionally fast and stack-free: default `pnpm test` must not
 * require Postgres, pgvector, or an embedding sidecar, and must not rewrite
 * baseline JSON. Real dense quality/latency captures live in `.int.ts` files
 * behind explicit `pnpm test:eval:*` scripts.
 */

import { describe, expect, it } from "vitest";
import { discoverProtocolCapabilities } from "../../vex-agent/tools/protocols/runtime.js";
import {
  loadDataset,
  validateDatasetExpectedTools,
  validateDatasetPrompts,
  type SeedQuery,
} from "./retrieval-eval-harness.js";

// Agent Scan phase 1 (2026-07-22): the dataset shrank from 200 to 116 when
// polymarket + KyberSwap zap + KyberSwap limit orders were deleted and the old
// kyberswap.swap.buy/sell split was unified into kyberswap.swap.execute (10
// rows remapped in place, 8 rows pruned to their surviving Jupiter
// alternative, 84 rows deleted outright — no query text was invented to
// backfill back to 200; see tool-discovery-seed.json's description). The
// awareness split is no longer 100/100 by construction — deletions only ever
// removed rows from their original half, so it stayed close (55/61) rather
// than being independently rebalanced.
const EXPECTED_QUERY_COUNT = 116;
const EXPECTED_BLIND_COUNT = 55;
const EXPECTED_PROTOCOL_AWARE_COUNT = 61;

const dataset = loadDataset();

function countByAwareness(queries: readonly SeedQuery[], awareness: SeedQuery["awareness"]): number {
  return queries.filter((query) => query.awareness === awareness).length;
}

describe("discover_tools English v3 dataset contract", () => {
  it("loads exactly 116 English seed queries split 55/61 by awareness", () => {
    expect(dataset).toHaveLength(EXPECTED_QUERY_COUNT);
    expect(countByAwareness(dataset, "blind")).toBe(EXPECTED_BLIND_COUNT);
    expect(countByAwareness(dataset, "protocol-aware")).toBe(EXPECTED_PROTOCOL_AWARE_COUNT);

    const nonAsciiQueries = dataset
      .filter((query) => !/^[\x00-\x7F]+$/.test(query.query))
      .map((query) => query.query);
    expect(nonAsciiQueries, `Non-ASCII seed queries:\n${nonAsciiQueries.join("\n")}`).toEqual([]);
  });

  it("keeps blind prompts protocol-free and protocol-aware prompts function-blind", () => {
    expect(validateDatasetPrompts(dataset)).toEqual([]);
  });

  it("references only active, real tool IDs or active tool prefixes", () => {
    expect(validateDatasetExpectedTools(dataset)).toEqual([]);
  });

  it("catalog listing does not touch dense retrieval", async () => {
    const result = await discoverProtocolCapabilities({ limit: 5 });
    expect(result.success).toBe(true);
    expect(result.count).toBeGreaterThan(0);
    expect(result.retrieval).toEqual({
      method: "catalog",
      denseFailed: false,
      candidateCount: result.totalCount,
    });
  });
});
