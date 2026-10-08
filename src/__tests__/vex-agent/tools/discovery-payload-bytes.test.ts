/**
 * Kairos Phase 6 measurements for P-2 and T-5, stack-free (lexical ranking,
 * no embeddings endpoint, no database).
 *
 * P-2 COST SIDE: the tools-array bytes one `ToolSearch` query adds when every
 * ranked row is injected (today) versus only the top `P2_INJECT_TOP_N_WHEN_ON`.
 * P-2 QUALITY SIDE: on the canonical lexical seed eval, how many queries put
 * their first expected tool at rank 3-5, i.e. inside today's injected set but
 * outside the top N. Each is a query that costs an extra select round under
 * P-2 ON. The dense eval, which the app actually runs, is PENDING: it needs
 * pgvector plus an embeddings endpoint.
 * T-5 COST SIDE: the static bytes the preload adds to every request.
 *
 * Numbers are printed (one JSON line) for the tracker and pinned loosely so a
 * large drift is noticed.
 */

import { describe, expect, it } from "vitest";

import { applyRequiresEnvSentinels } from "../../eval/requires-env-sentinels.js";
import { loadDataset } from "../../eval/retrieval-eval-harness.js";
import {
  buildDiscoveryCandidates,
  evaluateLexicalQueries,
  lexicalTopIds,
} from "../../eval/lexical-retrieval.js";
import { getProtocolManifest } from "@vex-agent/tools/protocols/catalog.js";
import {
  protocolToolDescription,
  protocolToolInputSchema,
} from "@vex-agent/tools/registry/protocol-tool-projection.js";
import { P2_INJECT_TOP_N_WHEN_ON } from "@vex-agent/tools/registry/discovery-policy.js";
import { CORE_MARKET_READ_TOOL_IDS } from "@vex-agent/tools/registry/core-market-reads.js";
import { DEFAULT_DISCOVERY_LIMIT } from "@vex-agent/tools/protocols/discovery.js";

applyRequiresEnvSentinels();

/** The bytes a toolId adds to a request's tools array, projected as injection projects it. */
function schemaBytes(toolId: string): number {
  const manifest = getProtocolManifest(toolId);
  if (!manifest) return 0;
  return JSON.stringify({
    type: "function",
    function: {
      name: manifest.publicName,
      description: protocolToolDescription(manifest),
      parameters: protocolToolInputSchema(manifest),
    },
  }).length;
}

const REPRESENTATIVE_QUERIES = [
  "price of ETH",
  "swap quote on base",
  "bridge USDC from base to arbitrum",
  "trending tokens on solana",
  "lend USDC on morpho",
  "pendle fixed yield",
  "token safety check",
  "open a perp position on lighter",
] as const;

describe("Phase 6 discovery payload measurements", () => {
  const candidates = buildDiscoveryCandidates();

  it("P-2: injected bytes per query, today versus top N", () => {
    const rows = REPRESENTATIVE_QUERIES.map((query) => {
      const top = lexicalTopIds(query, DEFAULT_DISCOVERY_LIMIT, candidates);
      const all = top.reduce((sum, id) => sum + schemaBytes(id), 0);
      const topN = top.slice(0, P2_INJECT_TOP_N_WHEN_ON).reduce((sum, id) => sum + schemaBytes(id), 0);
      return { query, off: all, on: topN };
    });
    const offTotal = rows.reduce((sum, row) => sum + row.off, 0);
    const onTotal = rows.reduce((sum, row) => sum + row.on, 0);
    process.stdout.write(`${JSON.stringify({ p2InjectedBytes: rows, offTotal, onTotal })}\n`);
    for (const row of rows) expect(row.on).toBeLessThanOrEqual(row.off);
    expect(onTotal).toBeLessThan(offTotal);
  });

  it("P-2: lexical seed eval, first expected tool at rank 1-2 versus 3-5", () => {
    const results = evaluateLexicalQueries(loadDataset(), DEFAULT_DISCOVERY_LIMIT, candidates);
    // `hitRank` is 0-based, -1 when no expected tool is in the top five.
    const inTopN = results.filter((r) => r.hitRank >= 0 && r.hitRank < P2_INJECT_TOP_N_WHEN_ON).length;
    const rank3to5 = results.filter((r) => r.hitRank >= P2_INJECT_TOP_N_WHEN_ON).length;
    const miss = results.filter((r) => r.hitRank < 0).length;
    process.stdout.write(`${JSON.stringify({ p2LexicalSeed: { queries: results.length, inTopN, rank3to5, miss } })}\n`);
    expect(inTopN + rank3to5 + miss).toBe(results.length);
    // Any rank 3-5 hit is an extra select round under P-2 ON: why it ships OFF.
    expect(rank3to5).toBeGreaterThan(0);
  }, 120_000);

  it("T-5: the preload's static bytes per request", () => {
    const bytes = CORE_MARKET_READ_TOOL_IDS.map((id) => ({ id, bytes: schemaBytes(id) }));
    const total = bytes.reduce((sum, row) => sum + row.bytes, 0);
    process.stdout.write(`${JSON.stringify({ t5PreloadBytes: bytes, total })}\n`);
    expect(total).toBeGreaterThan(0);
    expect(total).toBeLessThan(25_000);
  });
});
