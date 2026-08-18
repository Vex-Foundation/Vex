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
 * No character-budget ceilings live here any more (owner decision, 2026-08-17).
 * `SOLANA_LIST_CHAR_BUDGET` and `ANY_LIST_CHAR_BUDGET` were raised seven times
 * across this project, which means they never tracked a real constraint - each
 * raise just restated the latest measurement. Do not reintroduce one.
 *
 * The real guards are the runtime bounds (`MAX_DESCRIBE_TOOL_IDS`,
 * `MAX_DISCOVERY_LIMIT`, `MAX_DISCOVERED_TOOLS_PER_SESSION`) plus the
 * comparative assertion below: a lean listing must be smaller than the same
 * namespace's full-schema listing, which is the actual invariant of list mode
 * and needs no magic number.
 */

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

  it("keeps the biggest-by-tool-count namespace (solana) leaner than its full schema", async () => {
    const lean = JSON.stringify(await discoverProtocolCapabilities({ list: true, namespace: "solana" }));
    const full = JSON.stringify(await discoverProtocolCapabilities({ namespace: "solana", limit: 999 }));
    expect(lean.length, `solana: lean ${lean.length} vs full ${full.length}`).toBeLessThan(full.length);
  });

  it("keeps EVERY namespace listing below its full-schema cost", async () => {
    for (const namespace of PROTOCOL_ADVERTISED_NAMESPACE_ALLOWLIST) {
      const lean = JSON.stringify(await discoverProtocolCapabilities({ list: true, namespace }));
      const full = JSON.stringify(await discoverProtocolCapabilities({ namespace, limit: 999 }));
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
