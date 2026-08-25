/**
 * W7 discovery payload (SPEC §1.7) — what a `discover_tools` row must carry
 * before the model can build a call from it.
 *
 * Ranked rows: `exampleParams`, `required`, `actionKind`, and `constraints`
 * when the manifest declares XOR groups. List rows: `actionKind` +
 * `requiredParams` (names only — never the full schema). An empty namespace
 * says WHY it is empty.
 */

import assert from "node:assert/strict";

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { discoverProtocolCapabilities } from "@vex-agent/tools/protocols/runtime.js";
import { DEFAULT_DISCOVERY_LIMIT, isRankedDiscoveryItem } from "@vex-agent/tools/protocols/discovery.js";
import { describeParamGroupConstraints } from "@vex-agent/tools/protocols/runtime/params.js";
import {
  PROTOCOL_TOOLS,
  getProtocolManifest,
  isProtocolToolAvailable,
} from "@vex-agent/tools/protocols/catalog.js";
import type { ProtocolToolManifest } from "@vex-agent/tools/protocols/types.js";

/** Every discovered row must have a manifest — a missing one is the failure. */
function manifestFor(toolId: string): ProtocolToolManifest {
  const manifest = getProtocolManifest(toolId);
  assert.ok(manifest, `no manifest for ${toolId}`);
  return manifest;
}

describe("discover_tools ranked payload", () => {
  it("carries actionKind, required, and the manifest's exampleParams on every row", async () => {
    const result = await discoverProtocolCapabilities({ namespace: "dexscreener", limit: 50 });
    expect(result.tools.length).toBeGreaterThan(0);
    for (const tool of result.tools) {
      if (!isRankedDiscoveryItem(tool)) throw new Error("expected ranked rows");
      const manifest = manifestFor(tool.toolId);
      expect(tool.actionKind).toBe(manifest.actionKind);
      expect(tool.exampleParams).toEqual(manifest.exampleParams);
      expect(tool.required).toEqual(
        manifest.params.filter((p) => p.required === true).map((p) => p.key),
      );
    }
  });

  it("ships the worked call the missing-required failure was about", async () => {
    const result = await discoverProtocolCapabilities({ query: "dexscreener.search", limit: 3 });
    const row = result.tools.find((t) => t.toolId === "dexscreener.search");
    assert.ok(row, "dexscreener.search was not discovered");
    assert.ok(isRankedDiscoveryItem(row), "expected a ranked row");
    expect(row.exampleParams).toMatchObject({ query: expect.any(String) });
    expect(row.required).toContain("query");
  });

  // The guard must skip every manifest that declares ANY param-group family,
  // not just `exclusiveParamGroups`. `atLeastOneOf` (which plan 14.6 item 11
  // mandates on pair_get and pairs_batch_get) also renders a constraint
  // sentence, so the narrower guard failed a manifest that was behaving
  // correctly. `describeParamGroupConstraints` is the same predicate the
  // coverage block below already uses, and it owns all three families.
  it("omits constraints on a manifest that declares no param-group constraints", async () => {
    const result = await discoverProtocolCapabilities({ namespace: "dexscreener", limit: 50 });
    for (const tool of result.tools) {
      const manifest = manifestFor(tool.toolId);
      if (describeParamGroupConstraints(manifest).length > 0) continue;
      expect(tool).not.toHaveProperty("constraints");
    }
  });

  // A `checked >= 0` assertion passes on an empty loop, so it proved nothing.
  // The expected set is DERIVED from the catalog and asserted exactly, and all
  // THREE group families must be represented in it.
  describe("param-group constraints", () => {
    const declaringManifests = PROTOCOL_TOOLS.filter(
      (m) => describeParamGroupConstraints(m).length > 0,
    );

    // The three declaring namespaces include env-gated ones; a placeholder key
    // makes them discoverable so this coverage does not depend on the machine.
    const GATED_ENV_KEYS = ["JUPITER_API_KEY"] as const;
    const originalEnv: Record<string, string | undefined> = {};

    beforeEach(() => {
      for (const key of GATED_ENV_KEYS) {
        originalEnv[key] = process.env[key];
        process.env[key] = process.env[key] ?? "test-key";
      }
    });

    afterEach(() => {
      for (const key of GATED_ENV_KEYS) {
        if (originalEnv[key] === undefined) delete process.env[key];
        else process.env[key] = originalEnv[key];
      }
    });

    it("has at least one live manifest declaring EACH of the three group types", () => {
      const withField = (pick: (m: ProtocolToolManifest) => readonly unknown[] | undefined) =>
        declaringManifests.filter((m) => (pick(m) ?? []).length > 0).map((m) => m.toolId);

      expect(withField((m) => m.exclusiveParamGroups)).toContain("solana.prices");
      expect(withField((m) => m.atMostOne)).toContain("solana.lend.borrowOperate");
      expect(withField((m) => m.atLeastOneOf)).toContain("solana.lend.borrowOperate");
    });

    it("renders the runtime's own sentences on EVERY declaring manifest discovery serves", async () => {
      const expected = declaringManifests.filter(isProtocolToolAvailable);
      expect(expected.length).toBeGreaterThan(0);

      let checked = 0;
      for (const manifest of expected) {
        const result = await discoverProtocolCapabilities({ query: manifest.toolId, limit: 5 });
        const row = result.tools.find((t) => t.toolId === manifest.toolId);
        assert.ok(row, `${manifest.toolId} declares groups but was not discoverable`);
        assert.ok(isRankedDiscoveryItem(row), `${manifest.toolId} returned a non-ranked row`);
        expect(row.constraints).toEqual(describeParamGroupConstraints(manifest));
        checked += 1;
      }
      expect(checked).toBe(expected.length);
    });
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
      const manifest = manifestFor(tool.toolId);
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
