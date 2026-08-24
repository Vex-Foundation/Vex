/**
 * Registry completeness — structural invariants for the protocol catalog.
 *
 * Dopełnia `sync/capture-contract.test.ts` (which already asserts
 * `mutating → MUTATION_MATRIX` coverage). This file asserts the symmetric
 * side: manifest ↔ handler pairing, no duplicate tool IDs, namespace
 * allowlist coherence, and registration table consistency.
 *
 * Written against the post-PR1 `NAMESPACE_MODULES` registration model —
 * `catalog.ts` builds its indices from this table at module load and
 * throws on duplicates, so these tests are defense-in-depth: they catch
 * regressions earlier (fail one test instead of the whole module graph)
 * and document the invariants explicitly.
 */

import { describe, it, expect } from "vitest";
import {
  NAMESPACE_MODULES,
  PROTOCOL_TOOLS,
  PROTOCOL_NAMESPACE_ALLOWLIST,
  NAMESPACE_DEFAULTS,
  getProtocolHandler,
  getProtocolManifest,
  isAdvertisedProtocolNamespace,
  isKnownProtocolNamespace,
} from "@vex-agent/tools/protocols/catalog.js";
import { INTERNAL_TOOL_LOADERS } from "@vex-agent/tools/dispatcher.js";
import { MUTATING_PROTOCOL_ALIAS_ROUTERS } from "@vex-agent/tools/mutating-aliases.js";
import { getAllTools } from "@vex-agent/tools/registry.js";

describe("registry completeness", () => {
  it("every manifest has a handler and every handler has a manifest", () => {
    const manifestIds = new Set(PROTOCOL_TOOLS.map((m) => m.toolId));
    const handlerIds = new Set<string>();
    for (const mod of NAMESPACE_MODULES) {
      for (const id of Object.keys(mod.handlers)) handlerIds.add(id);
    }

    // manifest → handler
    const manifestsWithoutHandler = [...manifestIds].filter((id) => !handlerIds.has(id));
    expect(manifestsWithoutHandler, "manifests missing a handler").toEqual([]);

    // handler → manifest
    const handlersWithoutManifest = [...handlerIds].filter((id) => !manifestIds.has(id));
    expect(handlersWithoutManifest, "orphaned handlers (no manifest)").toEqual([]);
  });

  it("no duplicate toolId across namespace modules", () => {
    const seen = new Map<string, string>(); // toolId → namespace that registered it
    const duplicates: string[] = [];
    for (const mod of NAMESPACE_MODULES) {
      for (const manifest of mod.manifests) {
        const prior = seen.get(manifest.toolId);
        if (prior !== undefined) {
          duplicates.push(`${manifest.toolId}: ${prior} vs ${mod.namespace}`);
        } else {
          seen.set(manifest.toolId, mod.namespace);
        }
      }
    }
    expect(duplicates, "duplicate toolId across namespaces").toEqual([]);
  });

  it("every manifest.namespace matches the namespace module that registered it", () => {
    const mismatches: string[] = [];
    for (const mod of NAMESPACE_MODULES) {
      for (const manifest of mod.manifests) {
        if (manifest.namespace !== mod.namespace) {
          mismatches.push(`${manifest.toolId}: declares ${manifest.namespace}, registered under ${mod.namespace}`);
        }
      }
    }
    expect(mismatches, "manifest namespace mismatch").toEqual([]);
  });

  it("getProtocolManifest returns O(1) lookup equal to the registered manifest", () => {
    for (const manifest of PROTOCOL_TOOLS) {
      const fetched = getProtocolManifest(manifest.toolId);
      expect(fetched, `lookup missed for ${manifest.toolId}`).toBeDefined();
      expect(fetched).toBe(manifest); // reference equality — same object
    }
    expect(getProtocolManifest("definitely-nonexistent-tool-id")).toBeUndefined();
  });

  it("getProtocolHandler returns a function for every manifest.toolId", () => {
    const missing: string[] = [];
    for (const manifest of PROTOCOL_TOOLS) {
      const handler = getProtocolHandler(manifest.toolId);
      if (typeof handler !== "function") missing.push(manifest.toolId);
    }
    expect(missing, "manifests with no handler function").toEqual([]);
  });

  it("PROTOCOL_NAMESPACE_ALLOWLIST is covered by NAMESPACE_DEFAULTS", () => {
    for (const ns of PROTOCOL_NAMESPACE_ALLOWLIST) {
      expect(NAMESPACE_DEFAULTS[ns], `missing default for namespace ${ns}`).toBeDefined();
    }
  });

  it("every namespace in NAMESPACE_MODULES is in the allowlist", () => {
    const allowed = new Set<string>(PROTOCOL_NAMESPACE_ALLOWLIST);
    const extra = NAMESPACE_MODULES.map((m) => m.namespace).filter((ns) => !allowed.has(ns));
    expect(extra, "NAMESPACE_MODULES entry missing from PROTOCOL_NAMESPACE_ALLOWLIST").toEqual([]);
  });

  it("advertised namespaces are a subset of the allowlist", () => {
    for (const ns of PROTOCOL_NAMESPACE_ALLOWLIST) {
      if (isAdvertisedProtocolNamespace(ns)) {
        expect(isKnownProtocolNamespace(ns)).toBe(true);
      }
    }
  });

});

// ── Internal tool loaders ─────────────────────────────────────────────
//
// `tools/dispatcher.ts::INTERNAL_TOOL_LOADERS` is the table-driven lazy
// loader map that replaces the pre-PR1 25-case switch. Adding a new
// internal tool to `tools/registry.ts` without also adding a loader row
// silently returns `Unknown internal tool: X` at runtime — these asserts
// surface the mismatch at test time instead.
//
// DIRECT-DISPATCH internal tools live OUTSIDE `INTERNAL_TOOL_LOADERS` because
// `routeToolCall` dispatches them via a dedicated branch BEFORE the
// internal-tool fallback:
//   - the `ToolSearch` meta-tool → the ToolSearch dispatch lane,
//   - MUTATING protocol-aliases (Stage 8b, e.g. `swap`) → resolved target via
//     `executeProtocolTool`. These MUST bypass `routeInternalTool` so they skip
//     its internal mutating-approval gate (approval is owned by
//     `executeProtocolTool` after the Stage-7 prequote gate).
// They are excluded from the loader symmetry check; the exclusion is sourced
// from `MUTATING_PROTOCOL_ALIAS_ROUTERS` keys so it stays self-maintaining, and
// a separate assertion below proves every alias key is a real internal ToolDef
// (so the exclusion can never hide an orphan).

const META_TOOL_NAMES = new Set(["ToolSearch"]);
const MUTATING_ALIAS_NAMES = new Set(Object.keys(MUTATING_PROTOCOL_ALIAS_ROUTERS));
const DIRECT_DISPATCH_TOOL_NAMES = new Set([...META_TOOL_NAMES, ...MUTATING_ALIAS_NAMES]);

describe("dispatcher INTERNAL_TOOL_LOADERS completeness", () => {
  it("every kind='internal' ToolDef (except direct-dispatch tools) has an INTERNAL_TOOL_LOADERS entry", () => {
    const expected = getAllTools()
      .filter((t) => t.kind === "internal")
      .map((t) => t.name)
      .filter((n) => !DIRECT_DISPATCH_TOOL_NAMES.has(n));
    const loaders = new Set(Object.keys(INTERNAL_TOOL_LOADERS));
    const missing = expected.filter((n) => !loaders.has(n));
    expect(missing, "internal tools declared in registry without a dispatcher loader").toEqual([]);
  });

  it("every INTERNAL_TOOL_LOADERS key has a matching kind='internal' ToolDef", () => {
    const internalNames = new Set(
      getAllTools()
        .filter((t) => t.kind === "internal")
        .map((t) => t.name),
    );
    const orphans = Object.keys(INTERNAL_TOOL_LOADERS).filter((k) => !internalNames.has(k));
    expect(orphans, "INTERNAL_TOOL_LOADERS entries with no corresponding ToolDef").toEqual([]);
  });

  it("no INTERNAL_TOOL_LOADERS entry shadows a direct-dispatch tool name", () => {
    const loaders = Object.keys(INTERNAL_TOOL_LOADERS);
    const shadowed = loaders.filter((k) => DIRECT_DISPATCH_TOOL_NAMES.has(k));
    expect(shadowed, "direct-dispatch tools must stay out of INTERNAL_TOOL_LOADERS").toEqual([]);
  });

  it("every MUTATING_PROTOCOL_ALIAS_ROUTERS key is a registered kind='internal' mutating ToolDef", () => {
    // Orphan-guard: the loader-exclusion above hides alias keys from the
    // symmetry check, so prove each key is a real internal ToolDef that is
    // mutating — otherwise the exclusion could mask a typo'd / stale alias.
    const byName = new Map(getAllTools().map((t) => [t.name, t]));
    const problems: string[] = [];
    for (const name of MUTATING_ALIAS_NAMES) {
      const def = byName.get(name);
      if (!def) problems.push(`${name}: no ToolDef`);
      else if (def.kind !== "internal") problems.push(`${name}: kind=${def.kind} (expected internal)`);
      else if (def.mutating !== true) problems.push(`${name}: mutating=${def.mutating} (expected true)`);
    }
    expect(problems, "mutating protocol-alias keys not backed by a mutating internal ToolDef").toEqual([]);
  });

  it("every INTERNAL_TOOL_LOADERS value is a function (loader factory)", () => {
    for (const [name, loader] of Object.entries(INTERNAL_TOOL_LOADERS)) {
      expect(typeof loader, `loader for ${name} should be a function`).toBe("function");
    }
  });
});
