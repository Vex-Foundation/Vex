/**
 * `describe_tools` — selective full-manifest fetch (R5, owner directives
 * D1/D2/D3, 2026-08-04).
 *
 * The second half of the two-step flow the owner asked for: `discover_tools
 * (list:true)` stays a cheap index of names + descriptions, and THIS tool turns
 * a chosen subset of those toolIds into complete model-facing manifests that are
 * ALSO callable by name on the very next step.
 *
 * The properties this suite exists to pin:
 *
 *  1. **D3 equivalence** — a tool reached by list→describe is indistinguishable
 *     from the same tool reached by ranked discovery: the same row builder AND
 *     the same injected function schema. Since full-manifest injection the live
 *     agent has produced zero invalid-parameter calls; a second, lighter path
 *     would silently degrade that.
 *  2. **Nothing is silently dropped or clamped** — an over-bound call, a
 *     malformed id, an unknown/env-gated/non-advertised id, and an earlier round
 *     displaced by the session cap are each answered BY NAME with the real
 *     cause.
 *  3. **It is not a gate bypass** — it applies the SAME advertised / lifecycle+env
 *     / reveal gates discovery applies, so it can never hand the model a manifest
 *     `executeProtocolTool` would then hard-reject.
 *  4. **The bounds are catalog-DERIVED**, so a future 41-tool namespace fails
 *     this suite instead of silently refusing or dropping.
 */

import assert from "node:assert/strict";

import { describe, it, expect, beforeEach, afterEach } from "vitest";

import {
  MAX_DESCRIBE_TOOL_IDS,
  describeProtocolTools,
  isRankedDiscoveryItem,
} from "@vex-agent/tools/protocols/discovery.js";
import { handleDescribeTools } from "@vex-agent/tools/internal/describe-tools.js";
import { discoverProtocolCapabilities } from "@vex-agent/tools/protocols/runtime.js";
import { revealDescribeTools } from "@vex-agent/tools/registry/describe-tools-reveal.js";
import {
  MAX_DISCOVERED_TOOLS_PER_SESSION,
  clearDiscoveredTools,
  getDiscoveredToolIds,
  recordDiscoveredTools,
} from "@vex-agent/tools/registry/discovered-tools.js";
import { buildInjectedProtocolTools } from "@vex-agent/tools/registry/injected-protocol-tools.js";
import { defaultVisibilityContext } from "@vex-agent/tools/registry/visibility.js";
import {
  PROTOCOL_ADVERTISED_NAMESPACE_ALLOWLIST,
  PROTOCOL_TOOLS,
  isProtocolToolAvailable,
} from "@vex-agent/tools/protocols/catalog.js";
import { describeParamGroupConstraints } from "@vex-agent/tools/protocols/runtime/params.js";
import { makeTestContext } from "./_test-context.js";

const SESSION = "describe-tools-suite";

/**
 * Serialized worst LEGAL result budget: a bound-sized fetch of the catalog's
 * most expensive manifests PLUS a full round of displaced-id warnings. The
 * row-only budget is not the worst case (Codex arc-2 final) — a call into a
 * full session set also names every id it displaced.
 *
 * Measured 2026-08-04 by `probes/worst-legal-flow.ts`: 166,162 chars for the 40
 * most expensive manifests in the catalog with a full displacement warning. The
 * ratchet sits above that with headroom, and its job is to make a future
 * 37-param manifest fail HERE rather than silently blow the context envelope.
 */
const DESCRIBE_RESULT_CHAR_BUDGET = 185_000;

/** The env vars this suite pins, restored after every case. */
const ENV_KEYS = [
  "JUPITER_API_KEY",
  "POLYMARKET_API_KEY",
  "EMBEDDING_BASE_URL",
  "EMBEDDING_MODEL",
  "EMBEDDING_DIM",
  "EMBEDDING_PROVIDER",
] as const;
const originalEnv: Record<string, string | undefined> = {};

function availableToolIds(namespace: string): string[] {
  return PROTOCOL_TOOLS
    .filter((manifest) => manifest.namespace === namespace)
    .filter(isProtocolToolAvailable)
    .map((manifest) => manifest.toolId);
}

/**
 * Computed lazily, never at module load: availability reads `process.env`, and
 * at import time the env-gated namespaces (solana behind `JUPITER_API_KEY`) are
 * still unavailable — which would silently derive the floor from the wrong
 * namespace and make the bound assertions weaker than they look.
 */
const largestNamespaceSize = () => Math.max(
  ...PROTOCOL_ADVERTISED_NAMESPACE_ALLOWLIST.map((ns) => availableToolIds(ns).length),
);

/** Every advertised, available toolId, longest namespace first — the bound-filling pool. */
function catalogPool(): string[] {
  return PROTOCOL_ADVERTISED_NAMESPACE_ALLOWLIST.flatMap(availableToolIds);
}

async function describe_(toolIds: unknown, sessionId: string = SESSION) {
  return handleDescribeTools({ toolIds }, makeTestContext({ sessionId }));
}

/** The parsed model-facing envelope of a successful call. */
async function describeOk(toolIds: unknown, sessionId: string = SESSION) {
  const result = await describe_(toolIds, sessionId);
  return { result, payload: JSON.parse(result.output) };
}

beforeEach(() => {
  for (const key of ENV_KEYS) originalEnv[key] = process.env[key];
  process.env.JUPITER_API_KEY = "test-key";
  process.env.POLYMARKET_API_KEY = "test-key";
  // Dense retrieval must not reach the network — discovery falls back to lexical.
  delete process.env.EMBEDDING_BASE_URL;
  delete process.env.EMBEDDING_MODEL;
  delete process.env.EMBEDDING_DIM;
  delete process.env.EMBEDDING_PROVIDER;
  clearDiscoveredTools(SESSION);
  revealDescribeTools(SESSION);
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
  clearDiscoveredTools(SESSION);
});

describe("describe_tools — the manifest projection", () => {
  it("returns the COMPLETE manifest projection and no ranking evidence", async () => {
    const { result, payload } = await describeOk(["dexscreener.search", "dexscreener.tokenPairs"]);

    expect(result.success).toBe(true);
    expect(payload.count).toBe(2);
    expect(payload.tools).toHaveLength(2);
    expect(payload.warnings).toEqual([]);

    const [search] = payload.tools;
    const manifest = PROTOCOL_TOOLS.find((m) => m.toolId === "dexscreener.search");
    if (manifest === undefined) throw new Error("dexscreener.search manifest missing");
    expect(search.toolId).toBe("dexscreener.search");
    expect(search.namespace).toBe(manifest.namespace);
    expect(search.description).toBe(manifest.description);
    expect(search.mutating).toBe(manifest.mutating);
    expect(search.actionKind).toBe(manifest.actionKind);
    expect(search.params).toEqual(manifest.params);
    expect(search.exampleParams).toEqual(manifest.exampleParams);
    expect(search.required)
      .toEqual(manifest.params.filter((p) => p.required === true).map((p) => p.key));

    // Ranking evidence belongs to retrieval; nothing was retrieved or ranked.
    expect(search).not.toHaveProperty("score");
    expect(search).not.toHaveProperty("whyMatched");
    // Internal manifest metadata is never returned.
    expect(search).not.toHaveProperty("lifecycle");
    expect(search).not.toHaveProperty("requiresEnv");
    expect(search).not.toHaveProperty("discovery");
  });

  it("carries `constraints` verbatim for a manifest that declares a param group, and omits the key otherwise", async () => {
    // `virtuals.list` declares an at-most-one group and is NOT env-gated.
    const { payload } = await describeOk(["virtuals.list", "dexscreener.search"]);
    const [virtuals, dexscreener] = payload.tools;

    const manifest = PROTOCOL_TOOLS.find((m) => m.toolId === "virtuals.list");
    if (manifest === undefined) throw new Error("virtuals.list manifest missing");
    expect(virtuals.constraints).toEqual(describeParamGroupConstraints(manifest));
    expect(virtuals.constraints.length).toBeGreaterThan(0);
    // A tool without groups pays nothing — the key is absent, not empty.
    expect(dexscreener).not.toHaveProperty("constraints");
  });

  it("covers all three param-group types", async () => {
    // exactly-one (`solana.prices`), at-most-one (`solana.lend.withdraw`),
    // and a manifest declaring both at-most-one AND at-least-one.
    const ids = ["solana.prices", "solana.lend.withdraw", "solana.lend.borrowOperate"];
    const { payload } = await describeOk(ids);

    expect(payload.count).toBe(3);
    for (const row of payload.tools) {
      const manifest = PROTOCOL_TOOLS.find((m) => m.toolId === row.toolId);
      if (manifest === undefined) throw new Error(`no manifest for ${row.toolId}`);
      expect(row.constraints).toEqual(describeParamGroupConstraints(manifest));
      expect(row.constraints.length).toBeGreaterThan(0);
    }
  });

  it("preserves a declared `unit` on a param verbatim", async () => {
    const withUnit = PROTOCOL_TOOLS
      .filter(isProtocolToolAvailable)
      .find((m) => m.params.some((p) => p.unit !== undefined));
    if (withUnit === undefined) throw new Error("no available manifest declares a param unit");
    const { payload } = await describeOk([withUnit.toolId]);
    expect(payload.tools[0].params).toEqual(withUnit.params);
    expect(payload.tools[0].params.some((p: { unit?: string }) => p.unit !== undefined)).toBe(true);
  });
});

describe("describe_tools — the pressure advisory", () => {
  const rowsAt = (band: "barrier" | "critical" | "normal", bypass = false) =>
    describeProtocolTools(
      availableToolIds("trench").slice(0, 6),
      { sessionId: SESSION, contextUsageBand: band, preparationBypassesBarrier: bypass },
    );

  it("tags mutating rows at barrier and critical, never read rows", () => {
    for (const band of ["barrier", "critical"] as const) {
      for (const row of rowsAt(band).tools) {
        expect(row.unavailable_at_pressure, `${row.toolId} at ${band}`)
          .toBe(row.mutating ? true : undefined);
      }
    }
  });

  it("tags nothing at barrier while a preparation bypasses it, and still tags at critical", () => {
    for (const row of rowsAt("barrier", true).tools) {
      expect(row.unavailable_at_pressure, row.toolId).toBeUndefined();
    }
    const criticalMutating = rowsAt("critical", true).tools.filter((r) => r.mutating);
    expect(criticalMutating.length).toBeGreaterThan(0);
    for (const row of criticalMutating) expect(row.unavailable_at_pressure).toBe(true);
  });

  it("tags nothing at the normal band", () => {
    for (const row of rowsAt("normal").tools) {
      expect(row.unavailable_at_pressure, row.toolId).toBeUndefined();
    }
  });
});

describe("describe_tools — bounds are derived from the catalog, never chosen", () => {
  it("the per-call bound fits the LARGEST advertised namespace whole", () => {
    // Owner directive D2: "agent może pobrać pełny namespace protokołu". A bound
    // below the largest namespace would refuse that flow outright.
    expect(MAX_DESCRIBE_TOOL_IDS).toBeGreaterThanOrEqual(largestNamespaceSize());
  });

  it("the session cap is >= the per-call bound, so a call can never evict its OWN results", () => {
    // Deliberately `>=`, not equality: retention policy and response-size policy
    // must be able to move independently. They happen to be equal today.
    expect(MAX_DISCOVERED_TOOLS_PER_SESSION).toBeGreaterThanOrEqual(MAX_DESCRIBE_TOOL_IDS);
  });

  it("accepts exactly the bound", async () => {
    const ids = catalogPool().slice(0, MAX_DESCRIBE_TOOL_IDS);
    expect(ids).toHaveLength(MAX_DESCRIBE_TOOL_IDS);
    const { result, payload } = await describeOk(ids);
    expect(result.success).toBe(true);
    expect(payload.count).toBe(MAX_DESCRIBE_TOOL_IDS);
  });

  it("rejects one over the bound BY NAME, runs nothing and records nothing", async () => {
    const ids = catalogPool().slice(0, MAX_DESCRIBE_TOOL_IDS + 1);
    const result = await describe_(ids);

    expect(result.success).toBe(false);
    expect(result.output).toContain(String(MAX_DESCRIBE_TOOL_IDS + 1));
    expect(result.output).toContain(String(MAX_DESCRIBE_TOOL_IDS));
    // Never a silent slice — the whole call is refused and nothing is recorded.
    expect(getDiscoveredToolIds(SESSION)).toEqual([]);
    expect(() => JSON.parse(result.output)).toThrow();
  });

  it("fetches a WHOLE namespace in one call and records every tool of it", async () => {
    // The case that silently dropped 10 of solana's 34 at the old 24-slot cap.
    const solana = availableToolIds("solana");
    expect(solana).toHaveLength(largestNamespaceSize());

    const { result, payload } = await describeOk(solana);
    expect(result.success).toBe(true);
    expect(payload.count).toBe(solana.length);
    expect(payload.tools.map((t: { toolId: string }) => t.toolId).sort()).toEqual([...solana].sort());
    expect([...getDiscoveredToolIds(SESSION)].sort()).toEqual([...solana].sort());
  });

  it("a bound-sized call into a FULL session set still keeps all of its own results", async () => {
    recordDiscoveredTools(SESSION, catalogPool().slice(-MAX_DISCOVERED_TOOLS_PER_SESSION));
    const requested = catalogPool().slice(0, MAX_DESCRIBE_TOOL_IDS);

    const { payload } = await describeOk(requested);
    const kept = new Set(getDiscoveredToolIds(SESSION));
    for (const id of requested) {
      expect(kept.has(id), `${id} was evicted by the very call that fetched it`).toBe(true);
    }
    expect(payload.sessionCapacity).toEqual({
      used: MAX_DISCOVERED_TOOLS_PER_SESSION,
      max: MAX_DISCOVERED_TOOLS_PER_SESSION,
    });
  });

  it("NAMES every id it displaced from an earlier round, and warns about none when it displaced none", async () => {
    const earlier = catalogPool().slice(0, MAX_DISCOVERED_TOOLS_PER_SESSION);
    recordDiscoveredTools(SESSION, earlier);

    const fresh = catalogPool().slice(-5);
    const { payload } = await describeOk(fresh);

    const displaced = earlier.filter((id) => !getDiscoveredToolIds(SESSION).includes(id));
    expect(displaced.length).toBeGreaterThan(0);
    const warningText = payload.warnings.join(" ");
    for (const id of displaced) {
      expect(warningText, `displaced id ${id} vanished with no signal`).toContain(id);
    }

    // A call that displaces nothing must not manufacture a displacement warning.
    clearDiscoveredTools(SESSION);
    const { payload: clean } = await describeOk(["dexscreener.search"]);
    expect(clean.warnings).toEqual([]);
    expect(clean.sessionCapacity).toEqual({ used: 1, max: MAX_DISCOVERED_TOOLS_PER_SESSION });
  });

  it("the worst LEGAL result — a bound-sized fetch plus a full round of displacement warnings — stays inside its budget", async () => {
    recordDiscoveredTools(SESSION, catalogPool().slice(-MAX_DISCOVERED_TOOLS_PER_SESSION));
    // The catalog's most expensive manifests, not an arbitrary slice.
    const bySize = [...PROTOCOL_TOOLS]
      .filter(isProtocolToolAvailable)
      .filter((m) => PROTOCOL_ADVERTISED_NAMESPACE_ALLOWLIST.includes(m.namespace))
      .sort((a, b) => JSON.stringify(b).length - JSON.stringify(a).length)
      .slice(0, MAX_DESCRIBE_TOOL_IDS)
      .map((m) => m.toolId);

    const result = await describe_(bySize);
    expect(result.output.length).toBeLessThan(DESCRIBE_RESULT_CHAR_BUDGET);
  });
});

describe("describe_tools — input grammar, rejected before it is echoed", () => {
  it("EVERY toolId in the catalog satisfies the accepted grammar", async () => {
    // The count bound is not a payload bound, so ids are grammar-checked before
    // being echoed into `warnings`. This is the guard that a future manifest can
    // never be listable yet unfetchable.
    const { payload } = await describeOk(catalogPool().slice(0, MAX_DESCRIBE_TOOL_IDS));
    expect(payload.warnings).toEqual([]);

    const rest = catalogPool().slice(MAX_DESCRIBE_TOOL_IDS);
    for (let i = 0; i < rest.length; i += MAX_DESCRIBE_TOOL_IDS) {
      clearDiscoveredTools(SESSION);
      const { payload: batch } = await describeOk(rest.slice(i, i + MAX_DESCRIBE_TOOL_IDS));
      expect(batch.warnings, `a catalog toolId was rejected by its own grammar`).toEqual([]);
    }
  });

  it("rejects a malformed id BY NAME and never echoes it back", async () => {
    const hostile = "x".repeat(400);
    const result = await describe_(["dexscreener.search", hostile]);
    expect(result.success).toBe(false);
    expect(result.output).not.toContain(hostile);
    expect(result.output.length).toBeLessThan(1_000);
    expect(getDiscoveredToolIds(SESSION)).toEqual([]);
  });

  it("rejects a blank id, a non-string member, a non-array and an empty array by name", async () => {
    for (const bad of [[""], ["   "], ["dexscreener.search", 7], "dexscreener.search", [], {}, null]) {
      const result = await describe_(bad);
      expect(result.success, `${JSON.stringify(bad)} was accepted`).toBe(false);
      expect(result.output).toContain("toolIds");
    }
    expect(getDiscoveredToolIds(SESSION)).toEqual([]);
  });

  it("rejects an UNKNOWN argument by name instead of silently dropping it", async () => {
    // A dropped argument is a silent contract change: the model asked for
    // something and got a differently-shaped answer with no signal.
    const result = await handleDescribeTools(
      { toolIds: ["dexscreener.search"], limit: 5 },
      makeTestContext({ sessionId: SESSION }),
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain("limit");
    expect(getDiscoveredToolIds(SESSION)).toEqual([]);
  });

  it("rejects a whitespace-wrapped id by name rather than silently normalizing it", async () => {
    // Normalizing it would teach the model that a malformed id works, and the
    // id it believes it fetched is not the id it sent.
    const result = await describe_([" dexscreener.search "]);
    expect(result.success).toBe(false);
    expect(result.output).toContain("whitespace");
    expect(getDiscoveredToolIds(SESSION)).toEqual([]);
  });

  it("rejects an id that is not a dotted toolId at all", async () => {
    for (const bad of ["dexscreener", "dexscreener.", ".search", "dexscreener..search", "dex screener.search"]) {
      const result = await describe_([bad]);
      expect(result.success, `${bad} was accepted`).toBe(false);
    }
  });

  it("de-duplicates repeated ids and SAYS it did", async () => {
    const { payload } = await describeOk(["dexscreener.search", "dexscreener.search", "dexscreener.tokenPairs"]);
    expect(payload.count).toBe(2);
    expect(payload.warnings.join(" ")).toContain("dexscreener.search");
    expect(getDiscoveredToolIds(SESSION)).toHaveLength(2);
  });
});

describe("describe_tools — per-id rejection with the REAL cause", () => {
  it("names an unknown toolId and points at discover_tools", async () => {
    const { result, payload } = await describeOk(["dexscreener.search", "solana.swaps"]);

    expect(result.success).toBe(true);
    expect(payload.count).toBe(1);
    expect(payload.warnings.join(" ")).toContain("solana.swaps");
    expect(payload.warnings.join(" ")).toContain("discover_tools");
    // A partial batch still returns everything it could resolve.
    expect(payload.tools[0].toolId).toBe("dexscreener.search");
    expect(getDiscoveredToolIds(SESSION)).toEqual(["dexscreener.search"]);
  });

  it("names the env VAR of an env-gated tool, and never a value", async () => {
    delete process.env.JUPITER_API_KEY;
    const { payload } = await describeOk(["solana.prices"]);

    expect(payload.count).toBe(0);
    expect(payload.warnings.join(" ")).toContain("JUPITER_API_KEY");
    expect(payload.warnings.join(" ")).toContain("solana.prices");
    expect(getDiscoveredToolIds(SESSION)).toEqual([]);
  });

  it("refuses a non-advertised namespace id — the advertisement gate, not the reveal branch", async () => {
    // `uniswap` is `advertised: false`, so it is filtered BEFORE reveal status is
    // ever consulted. This proves the ADVERTISEMENT gate; no advertised
    // reveal-only manifest exists in the catalog today to prove the other branch.
    const { payload } = await describeOk(["uniswap.swap.quote"]);
    expect(payload.count).toBe(0);
    expect(payload.warnings.join(" ")).toContain("uniswap.swap.quote");
    expect(getDiscoveredToolIds(SESSION)).toEqual([]);
  });

  it("is `success: false` only when NOTHING resolved", async () => {
    const allBad = await describe_(["solana.nope", "khalani.nope"]);
    expect(allBad.success).toBe(false);
    expect(JSON.parse(allBad.output).count).toBe(0);

    const partial = await describe_(["solana.nope", "dexscreener.search"]);
    expect(partial.success).toBe(true);
  });
});

describe("describe_tools — D3 equivalence with ranked discovery", () => {
  it("ROW PARITY: the described row equals the ranked row minus score/whyMatched", async () => {
    const toolId = "dexscreener.search";
    const ranked = await discoverProtocolCapabilities({
      query: toolId, namespace: "dexscreener", limit: 5, sessionId: SESSION,
    });
    const rankedRow = ranked.tools.find((t) => t.toolId === toolId);
    // Narrow through the real discriminator rather than casting: a list row
    // reaching here would silently make the parity assertion meaningless.
    expect(rankedRow && isRankedDiscoveryItem(rankedRow)).toBe(true);
    assert.ok(rankedRow !== undefined && isRankedDiscoveryItem(rankedRow));
    const { score: _score, whyMatched: _why, ...rankedProjection } = rankedRow;

    const { payload } = await describeOk([toolId]);
    expect(payload.tools[0]).toEqual(rankedProjection);
  });

  it("SCHEMA PARITY: the injected function schema is byte-identical whichever path reached the tool", async () => {
    // `buildInjectedProtocolTools` resolves the CANONICAL manifest from the
    // stored ids and never reads the returned row, so row parity alone cannot
    // prove this — both must be asserted (Codex arc-2 turn 2).
    const toolId = "dexscreener.search";
    const injectedName = "dexscreener__search";
    const ctx = (sessionId: string) => defaultVisibilityContext({ sessionId });

    const rankedSession = `${SESSION}-ranked`;
    const describedSession = `${SESSION}-described`;
    clearDiscoveredTools(rankedSession);
    clearDiscoveredTools(describedSession);
    revealDescribeTools(describedSession);

    recordDiscoveredTools(rankedSession, [toolId]);
    await describe_([toolId], describedSession);

    const viaRanked = buildInjectedProtocolTools(ctx(rankedSession))
      .find((t) => t.function.name === injectedName);
    const viaDescribe = buildInjectedProtocolTools(ctx(describedSession))
      .find((t) => t.function.name === injectedName);

    expect(viaDescribe).toBeDefined();
    expect(JSON.stringify(viaDescribe)).toBe(JSON.stringify(viaRanked));

    clearDiscoveredTools(rankedSession);
    clearDiscoveredTools(describedSession);
  });

  it("a described tool is callable by name on the very next step", async () => {
    await describe_(["dexscreener.search"]);
    const injected = buildInjectedProtocolTools(defaultVisibilityContext({ sessionId: SESSION }));
    expect(injected.map((t) => t.function.name)).toContain("dexscreener__search");
  });
});
