/**
 * Namespace list mode (`discover_tools list:true`): the complete, lean index of
 * one protocol's advertised surface — no param schemas, no ranking, no limit
 * truncation, and never a whole-catalog dump.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { discoverProtocolCapabilities } from "../../../vex-agent/tools/protocols/runtime.js";
import { isRankedDiscoveryItem } from "../../../vex-agent/tools/protocols/discovery.js";
import {
  PROTOCOL_ADVERTISED_NAMESPACE_ALLOWLIST,
  PROTOCOL_TOOLS,
  isAdvertisedProtocolNamespace,
  isProtocolToolAvailable,
} from "../../../vex-agent/tools/protocols/catalog.js";

/**
 * Measured budgets (2026-07-30). solana has the most tools (34) at 17.6k chars;
 * pendle has fewer tools but the longest prose (29 rows, 22.9k). Both are far
 * below the full-schema equivalent of the same namespace (38k / 53k), which is
 * the point of list mode. These are ratchets against silent prose growth.
 */
/**
 * Raised 20,000 → 21,000 ONCE in round 3, measured on 2026-08-03. Both parts of
 * the delta:
 *
 *   17.6k  the 2026-07-30 measurement this ratchet was set from
 *   19,490 W7's row shape alone (`actionKind` + `requiredParams` on all 34
 *          solana rows) — measured by re-running this listing against the
 *          pre-round-3 solana manifests, so NONE of it is prose growth; the
 *          same change cost pendle 22.9k → 25.1k above.
 *   20,036 + W5a/W5c prose: `solana.lend.borrowOperate` now documents its
 *          same-direction ban (previously enforced by the handler and written
 *          down nowhere, so an agent could not predict the rejection), and
 *          `solana.predict.profile` no longer claims it works "for ANY wallet"
 *          when session scope rejects exactly that.
 *
 * 21,000 restores roughly the same headroom-to-measurement ratio the pendle
 * budget above carries. Still a ratchet against silent prose growth.
 */
const SOLANA_LIST_CHAR_BUDGET = 21_000;
/**
 * Raised 25,000 → 27,500 in W7 (SPEC §1.7): a list row now also carries
 * `actionKind` and `requiredParams`, which is what makes a listed tool
 * callable-shaped instead of a name the agent had to re-discover. Measured
 * cost on the worst case (pendle, 29 rows): 22.9k → 25.1k. Still a ratchet
 * against prose growth, and still far below the same namespace's full schema.
 *
 * Raised 27,500 -> 32,000 on 2026-08-17 (owner decision, morpho E3b-1): the
 * morpho namespace reached nine deliberately thorough lending manifests under
 * the extensive-descriptions decree and its lean list measured 30,808. The
 * ratchet's job is unchanged - silent prose growth still fails here first.
 *
 * Raised 32,000 -> 38,000 on 2026-08-17 (owner decision, morpho E3b-2): the
 * two vault execute manifests - the namespace's first fund-spending tools -
 * cost 6,191 chars in the listing after redundancy was trimmed; what remains
 * is the safety prose (two-transaction consent, non-atomicity remediations,
 * exact-amount approval policy). Measured 37,017 with them.
 */
const ANY_LIST_CHAR_BUDGET = 38_000;

describe("discover_tools namespace list mode", () => {
  const ENV_KEYS = [
    "JUPITER_API_KEY",
    "POLYMARKET_API_KEY",
    "EMBEDDING_BASE_URL",
    "EMBEDDING_MODEL",
    "EMBEDDING_DIM",
    "EMBEDDING_PROVIDER",
  ] as const;
  const original: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ENV_KEYS) original[k] = process.env[k];
    process.env.JUPITER_API_KEY = "test-jupiter-key";
    process.env.POLYMARKET_API_KEY = "test-polymarket-key";
    delete process.env.EMBEDDING_BASE_URL;
    delete process.env.EMBEDDING_MODEL;
    delete process.env.EMBEDDING_DIM;
    delete process.env.EMBEDDING_PROVIDER;
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (original[k] === undefined) delete process.env[k];
      else process.env[k] = original[k];
    }
  });

  it("refuses list mode without a namespace instead of dumping the catalog", async () => {
    const result = await discoverProtocolCapabilities({ list: true });
    expect(result.success).toBe(false);
    expect(result.tools).toHaveLength(0);
    expect(result.warnings.join(" ")).toContain("list mode requires a namespace");
  });

  it("refuses list mode without a namespace even when a query is present", async () => {
    const result = await discoverProtocolCapabilities({ list: true, query: "swap tokens" });
    expect(result.success).toBe(false);
    expect(result.tools).toHaveLength(0);
  });

  it("emits lean rows carrying no params, score, or whyMatched", async () => {
    const result = await discoverProtocolCapabilities({ list: true, namespace: "dexscreener" });
    expect(result.success).toBe(true);
    expect(result.tools.length).toBeGreaterThan(0);
    for (const tool of result.tools) {
      expect(isRankedDiscoveryItem(tool)).toBe(false);
      expect(tool).not.toHaveProperty("params");
      expect(tool).not.toHaveProperty("score");
      expect(tool).not.toHaveProperty("whyMatched");
      expect(tool.toolId).toBeTruthy();
      expect(tool.description).toBeTruthy();
      expect(typeof tool.mutating).toBe("boolean");
    }
  });

  it("tags the response retrieval.method as list", async () => {
    const result = await discoverProtocolCapabilities({ list: true, namespace: "dexscreener" });
    expect(result.retrieval?.method).toBe("list");
  });

  it("returns the COMPLETE namespace — no limit truncation", async () => {
    const namespace = "solana";
    const expected = PROTOCOL_TOOLS
      .filter((m) => m.namespace === namespace)
      .filter((m) => isAdvertisedProtocolNamespace(m.namespace))
      .filter(isProtocolToolAvailable)
      .map((m) => m.toolId)
      .sort();

    // limit:1 must NOT truncate a list — a partial list defeats its purpose.
    const result = await discoverProtocolCapabilities({ list: true, namespace, limit: 1 });
    expect(result.tools.map((t) => t.toolId).sort()).toEqual(expected);
    expect(result.count).toBe(expected.length);
    expect(result.totalCount).toBe(expected.length);
    expect(result.hasMore).toBe(false);
    expect(result.warnings).toEqual([]);
  });

  it("keeps the biggest-by-tool-count namespace (solana) inside its measured budget", async () => {
    const result = await discoverProtocolCapabilities({ list: true, namespace: "solana" });
    const serialized = JSON.stringify(result);
    expect(
      serialized.length,
      `solana lean list serialized to ${serialized.length} chars`,
    ).toBeLessThan(SOLANA_LIST_CHAR_BUDGET);
  });

  it("keeps EVERY namespace listing inside the budget and far below its full-schema cost", async () => {
    for (const namespace of PROTOCOL_ADVERTISED_NAMESPACE_ALLOWLIST) {
      const lean = JSON.stringify(await discoverProtocolCapabilities({ list: true, namespace }));
      const full = JSON.stringify(await discoverProtocolCapabilities({ namespace, limit: 999 }));
      expect(lean.length, `${namespace} lean list is ${lean.length} chars`).toBeLessThan(ANY_LIST_CHAR_BUDGET);
      expect(lean.length, `${namespace}: lean ${lean.length} vs full ${full.length}`).toBeLessThan(full.length);
    }
  });

  it("rejects an unknown namespace in list mode", async () => {
    const result = await discoverProtocolCapabilities({ list: true, namespace: "nope" });
    expect(result.success).toBe(false);
    expect(result.warnings.join(" ")).toContain("Unknown namespace");
  });

  it("leaves ordinary (non-list) discovery on the ranked shape", async () => {
    const result = await discoverProtocolCapabilities({ namespace: "dexscreener", limit: 3 });
    expect(result.retrieval?.method).not.toBe("list");
    for (const tool of result.tools) expect(isRankedDiscoveryItem(tool)).toBe(true);
  });
});
