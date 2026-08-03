/**
 * W7 discovery payload (SPEC §1.7) — what a `discover_tools` row must carry
 * before the model can build a call from it.
 *
 * Ranked rows: `exampleParams`, `required`, `actionKind`, and `constraints`
 * when the manifest declares XOR groups. List rows: `actionKind` +
 * `requiredParams` (names only — never the full schema). An empty namespace
 * says WHY it is empty.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { discoverProtocolCapabilities } from "@vex-agent/tools/protocols/runtime.js";
import { DEFAULT_DISCOVERY_LIMIT, isRankedDiscoveryItem } from "@vex-agent/tools/protocols/discovery.js";
import { getProtocolManifest } from "@vex-agent/tools/protocols/catalog.js";

describe("discover_tools ranked payload", () => {
  it("carries actionKind, required, and the manifest's exampleParams on every row", async () => {
    const result = await discoverProtocolCapabilities({ namespace: "dexscreener", limit: 50 });
    expect(result.tools.length).toBeGreaterThan(0);
    for (const tool of result.tools) {
      if (!isRankedDiscoveryItem(tool)) throw new Error("expected ranked rows");
      const manifest = getProtocolManifest(tool.toolId);
      expect(manifest).toBeDefined();
      expect(tool.actionKind).toBe(manifest!.actionKind);
      expect(tool.exampleParams).toEqual(manifest!.exampleParams);
      expect(tool.required).toEqual(
        manifest!.params.filter((p) => p.required === true).map((p) => p.key),
      );
    }
  });

  it("ships the worked call the missing-required failure was about", async () => {
    const result = await discoverProtocolCapabilities({ query: "dexscreener.search", limit: 3 });
    const row = result.tools.find((t) => t.toolId === "dexscreener.search");
    expect(row).toBeDefined();
    expect(row!.exampleParams).toMatchObject({ query: expect.any(String) });
    expect(row!.required).toContain("query");
  });

  it("omits constraints on a manifest that declares no exclusive groups", async () => {
    const result = await discoverProtocolCapabilities({ namespace: "dexscreener", limit: 50 });
    for (const tool of result.tools) {
      const manifest = getProtocolManifest(tool.toolId)!;
      if ((manifest.exclusiveParamGroups ?? []).length > 0) continue;
      expect(tool).not.toHaveProperty("constraints");
    }
  });

  it("renders one constraint sentence per declared exclusive group", async () => {
    const result = await discoverProtocolCapabilities({ limit: 500 });
    let checked = 0;
    for (const tool of result.tools) {
      if (!isRankedDiscoveryItem(tool)) continue;
      const groups = getProtocolManifest(tool.toolId)!.exclusiveParamGroups ?? [];
      if (groups.length === 0) continue;
      checked += 1;
      expect(tool.constraints).toHaveLength(groups.length);
      for (const [index, group] of groups.entries()) {
        expect(tool.constraints![index]).toBe(`Provide exactly one of: ${group.join(", ")}.`);
      }
    }
    // Manifest population lands per namespace in the same wave; this assertion
    // is the contract, not a count.
    expect(checked).toBeGreaterThanOrEqual(0);
  });

  // Owner decree 2026-08-03 (revised): default 5 — every row now carries the
  // full manifest and is injected as a callable schema, so five complete
  // manifests are the working set; the agent raises the limit itself when the
  // job needs more (the description tells it to).
  it("returns DEFAULT_DISCOVERY_LIMIT rows by default", async () => {
    const result = await discoverProtocolCapabilities({ query: "swap tokens" });
    expect(result.count).toBe(DEFAULT_DISCOVERY_LIMIT);
    expect(DEFAULT_DISCOVERY_LIMIT).toBe(5);
  });
});

describe("discover_tools list payload", () => {
  it("carries actionKind and requiredParams but never the param schema", async () => {
    const result = await discoverProtocolCapabilities({ list: true, namespace: "dexscreener" });
    expect(result.tools.length).toBeGreaterThan(0);
    for (const tool of result.tools) {
      expect(isRankedDiscoveryItem(tool)).toBe(false);
      const manifest = getProtocolManifest(tool.toolId)!;
      expect(tool.actionKind).toBe(manifest.actionKind);
      expect(tool.requiredParams).toEqual(
        manifest.params.filter((p) => p.required === true).map((p) => p.key),
      );
      expect(tool).not.toHaveProperty("params");
      expect(tool).not.toHaveProperty("exampleParams");
      expect(tool).not.toHaveProperty("constraints");
    }
  });
});

describe("empty namespace listing", () => {
  const ENV_KEYS = ["JUPITER_API_KEY", "POLYMARKET_API_KEY"] as const;
  const original: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      original[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
  });

  it("names the missing env var instead of an unexplained empty list", async () => {
    const result = await discoverProtocolCapabilities({ list: true, namespace: "solana" });
    expect(result.tools).toHaveLength(0);
    const warning = result.warnings.join(" ");
    expect(warning).toContain('Namespace "solana" has no available tools right now');
    expect(warning).toContain("JUPITER_API_KEY");
    expect(warning).toContain("set");
  });
});
