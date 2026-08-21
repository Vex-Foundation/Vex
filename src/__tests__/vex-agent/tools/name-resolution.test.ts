/**
 * The deprecation-alias resolver's own contract, plus the properties that make
 * its Batch 1 integration provably inert.
 *
 * 1. CONTRACT: unknown names pass through untouched (this module never decides
 *    a tool does not exist), a registered alias resolves, and resolution is
 *    single-hop and therefore idempotent, which is what lets several boundaries
 *    resolve defensively without coordinating.
 * 2. TABLE INVARIANTS: the authored entries obey single-hop, no-shadowing, and
 *    the per-entry removal-condition requirement.
 * 3. IDENTITY-MAP REGRESSION: with the PRODUCTION table, resolution is the
 *    identity for every name the runtime can actually see. Asserted against the
 *    REAL registry and the REAL protocol catalog rather than a copied list, so
 *    a tool added later is covered without touching this file.
 * 4. PRODUCTION PURITY: the test-only registration seam is not reachable from
 *    production code, so fixture aliases cannot ship. A static gate, because
 *    that is the only kind of check that can prove an absence.
 */

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

import { describe, it, expect, afterEach } from "vitest";

import {
  DEPRECATED_TOOL_ALIASES,
  registerToolNameAliasesForTest,
  resetToolNameAliasesForTest,
  resolveDeprecatedProtocolToolId,
  resolveToolName,
  type DeprecatedToolAlias,
} from "@vex-agent/tools/registry/name-resolution.js";
import { getAllTools } from "@vex-agent/tools/registry.js";
import { PROTOCOL_TOOLS } from "@vex-agent/tools/protocols/catalog.js";
import { toInjectedToolName } from "@vex-agent/tools/registry/injected-protocol-tools.js";

/** A complete fixture entry, so the typed contract is exercised as authored. */
function internalAlias(overrides: Partial<DeprecatedToolAlias> = {}): DeprecatedToolAlias {
  return {
    deprecatedName: "old_fixture_name",
    canonicalId: "units_convert",
    kind: "internal",
    since: "0.0.0-test",
    removeAfter: "no unresolved approval_queue row and no enabled plan names it",
    reason: "fixture",
    ...overrides,
  };
}

afterEach(() => {
  resetToolNameAliasesForTest();
});

describe("resolveToolName, contract", () => {
  it("passes an unknown name through unchanged", () => {
    expect(resolveToolName("definitely_not_a_tool")).toBe("definitely_not_a_tool");
    expect(resolveToolName("")).toBe("");
  });

  it("resolves a registered internal alias to its canonical name", () => {
    registerToolNameAliasesForTest([internalAlias()]);
    expect(resolveToolName("old_fixture_name")).toBe("units_convert");
  });

  it("is idempotent: resolving a resolved name is the identity", () => {
    registerToolNameAliasesForTest([internalAlias()]);
    const once = resolveToolName("old_fixture_name");
    expect(resolveToolName(once)).toBe(once);
  });

  it("removes exactly the fixture entries it added when disposed", () => {
    const dispose = registerToolNameAliasesForTest([internalAlias()]);
    expect(resolveToolName("old_fixture_name")).toBe("units_convert");
    dispose();
    expect(resolveToolName("old_fixture_name")).toBe("old_fixture_name");
  });
});

describe("resolveDeprecatedProtocolToolId, contract", () => {
  it("returns the toolId the table STATES, never an inversion of the name", () => {
    // The target grammar carries exactly one double underscore, at the
    // namespace boundary. Inverting it would produce `kyberswap.swap_quote`,
    // which is not a real toolId.
    registerToolNameAliasesForTest([
      {
        deprecatedName: "kyberswap__swap_quote",
        canonicalId: "kyberswap.swap.quote",
        kind: "protocol",
        since: "0.0.0-test",
        removeAfter: "retired name absent from the injected tools array",
        reason: "fixture",
      },
    ]);

    expect(resolveDeprecatedProtocolToolId("kyberswap__swap_quote")).toBe("kyberswap.swap.quote");
    expect(resolveDeprecatedProtocolToolId("kyberswap__swap_quote")).not.toBe(
      "kyberswap__swap_quote".split("__").join("."),
    );
  });

  it("returns undefined for a name with no alias entry", () => {
    expect(resolveDeprecatedProtocolToolId("kyberswap__swap__quote")).toBeUndefined();
    expect(resolveDeprecatedProtocolToolId("definitely_not_a_tool")).toBeUndefined();
  });

  it("keeps the two identity spaces separate", () => {
    registerToolNameAliasesForTest([internalAlias()]);
    // An internal alias resolves as a NAME and is not a protocol toolId.
    expect(resolveDeprecatedProtocolToolId("old_fixture_name")).toBeUndefined();
  });
});

describe("DEPRECATED_TOOL_ALIASES, authored table", () => {
  it("is empty in Batch 1 (no rename has landed yet)", () => {
    expect(DEPRECATED_TOOL_ALIASES).toEqual([]);
  });

  it("never chains: no canonicalId is itself a deprecatedName (single-hop rule)", () => {
    const deprecatedNames = new Set(DEPRECATED_TOOL_ALIASES.map((a) => a.deprecatedName));
    for (const alias of DEPRECATED_TOOL_ALIASES) {
      expect(
        deprecatedNames.has(alias.canonicalId),
        `alias "${alias.deprecatedName}" points at "${alias.canonicalId}", which is itself retired`,
      ).toBe(false);
      expect(alias.canonicalId).not.toBe(alias.deprecatedName);
    }
  });

  it("never shadows a live tool name or a live manifest id", () => {
    const liveNames = new Set<string>([
      ...getAllTools().map((tool) => tool.name),
      ...PROTOCOL_TOOLS.map((manifest) => toInjectedToolName(manifest.toolId)),
    ]);
    for (const alias of DEPRECATED_TOOL_ALIASES) {
      expect(
        liveNames.has(alias.deprecatedName),
        `retired name "${alias.deprecatedName}" collides with a live tool`,
      ).toBe(false);
    }
  });

  it("keeps every deprecatedName unique across BOTH identity kinds", () => {
    // The two derived maps are keyed by the same string space. A duplicate
    // entry would populate both, and internal dispatch would silently win.
    const seen = new Set<string>();
    for (const alias of DEPRECATED_TOOL_ALIASES) {
      expect(
        seen.has(alias.deprecatedName),
        `retired name "${alias.deprecatedName}" appears in more than one entry`,
      ).toBe(false);
      seen.add(alias.deprecatedName);
    }
  });

  it("points every internal entry at a registered internal tool", () => {
    const internalNames = new Set(getAllTools().map((tool) => tool.name));
    for (const alias of DEPRECATED_TOOL_ALIASES) {
      if (alias.kind !== "internal") continue;
      expect(
        internalNames.has(alias.canonicalId),
        `internal alias "${alias.deprecatedName}" targets "${alias.canonicalId}", which is not a registered internal tool`,
      ).toBe(true);
    }
  });

  it("keeps every deprecatedName callable and every identity field non-empty", () => {
    // A retired name once WAS a provider function name and must stay
    // expressible in stored approval rows, prompts, and the generated docs
    // table: provider function-name grammar, 64 characters maximum.
    const CALLABLE_NAME = /^[a-zA-Z0-9_-]{1,64}$/;
    for (const alias of DEPRECATED_TOOL_ALIASES) {
      expect(alias.deprecatedName).toMatch(CALLABLE_NAME);
      expect(alias.canonicalId.trim().length).toBeGreaterThan(0);
    }
  });

  it("states a removal CONDITION for every entry, never a bare date", () => {
    for (const alias of DEPRECATED_TOOL_ALIASES) {
      expect(alias.removeAfter.trim().length).toBeGreaterThan(0);
      // A bare date or version is not evaluable: an enabled plan_md predating
      // the rename can re-emit an old spelling indefinitely.
      expect(alias.removeAfter).not.toMatch(/^\s*(v?\d+[\d.]*|\d{4}-\d{2}(-\d{2})?)\s*$/);
      expect(alias.since.trim().length).toBeGreaterThan(0);
      expect(alias.reason.trim().length).toBeGreaterThan(0);
    }
  });

  it("points every protocol entry at a real manifest id", () => {
    const liveToolIds = new Set(PROTOCOL_TOOLS.map((manifest) => manifest.toolId));
    for (const alias of DEPRECATED_TOOL_ALIASES) {
      if (alias.kind !== "protocol") continue;
      expect(
        liveToolIds.has(alias.canonicalId),
        `protocol alias "${alias.deprecatedName}" names unknown toolId "${alias.canonicalId}"`,
      ).toBe(true);
    }
  });
});

describe("identity-map regression, resolution is a no-op for every live name", () => {
  it("leaves every registered internal tool name unchanged", () => {
    const names = getAllTools().map((tool) => tool.name);
    expect(names.length).toBeGreaterThan(0);
    const moved = names.filter((name) => resolveToolName(name) !== name);
    expect(moved).toEqual([]);
  });

  it("leaves every injected protocol tool name unchanged", () => {
    const names = PROTOCOL_TOOLS.map((manifest) => toInjectedToolName(manifest.toolId));
    expect(names.length).toBeGreaterThan(0);
    const moved = names.filter((name) => resolveToolName(name) !== name);
    expect(moved).toEqual([]);
    const aliased = names.filter((name) => resolveDeprecatedProtocolToolId(name) !== undefined);
    expect(aliased).toEqual([]);
  });

  it("leaves the protocol meta-tool names unchanged", () => {
    for (const name of ["discover_tools", "describe_tools", "execute_tool"]) {
      expect(resolveToolName(name)).toBe(name);
    }
  });
});

describe("production purity, the test seam cannot ship", () => {
  const repoRoot = process.cwd();
  /** The module that DEFINES the seam is not a consumer of it. */
  const RESOLVER_MODULE = "src/vex-agent/tools/registry/name-resolution.ts";

  function productionConsumers(symbol: string): string[] {
    // Filesystem grep, NOT `git grep`: this workflow intentionally has no
    // commit, so the invariant must hold over untracked files too - a fixture
    // leaked into an untracked production module would be invisible to a
    // tracked-only search. Exit code 1 means "no matches", which is the pass.
    let out: string;
    try {
      out = execFileSync("grep", ["-rl", "--include=*.ts", symbol, "src"], {
        cwd: repoRoot,
        encoding: "utf8",
      });
    } catch {
      return [];
    }
    return out
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .filter((file) => !file.includes("__tests__"))
      .filter((file) => file !== RESOLVER_MODULE);
  }

  it("no production module references the test-only alias registration", () => {
    expect(productionConsumers("registerToolNameAliasesForTest")).toEqual([]);
  });

  it("no production module references the test-only alias reset", () => {
    expect(productionConsumers("resetToolNameAliasesForTest")).toEqual([]);
  });

  it("the resolver module declares no runtime import (no cycle, no side effect)", () => {
    const source = readFileSync(path.join(repoRoot, RESOLVER_MODULE), "utf8");
    expect(source).not.toMatch(/^import\s/m);
  });
});
