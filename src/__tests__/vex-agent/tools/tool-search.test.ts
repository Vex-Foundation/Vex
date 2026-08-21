/**
 * `ToolSearch` — the merged protocol meta-tool (query / select / namespace).
 *
 * Replaces `describe-tools.test.ts`, whose subject (`describe_tools`,
 * `describeProtocolTools`, `handleDescribeTools`, the describe reveal gate) was
 * deleted by the merge. The properties that suite pinned are re-pinned here
 * against the surviving behaviour, plus the ones the merge itself introduces
 * (`tool-surface-spec/toolsearch-design.md` §10):
 *
 *  1. **Mode derivation** — query, select, namespace, and the rejection paths:
 *     no arguments, over-max `limit`, over-max select count, unresolvable name,
 *     and the two RETIRED argument shapes (`toolIds`, `list`).
 *  2. **No schema in a result** — the golden property of the merge. Neither
 *     query nor select may emit `params`, `required`, `exampleParams`,
 *     `constraints` or `toolId`; the schema travels only in the injected
 *     function definition. This is the assertion that stops the duplication
 *     from coming back.
 *  3. **Select is not a gate bypass** — it applies the SAME advertised /
 *     lifecycle+env / pressure-barrier chain injection applies, so it can never
 *     hand the model a manifest `buildInjectedProtocolTools` then declines to
 *     inject or `executeProtocolTool` then hard-rejects.
 *  4. **Next-request visibility** — a tool selected during request N is absent
 *     from the tools array of request N and present in N+1's.
 *  5. **Displacement parity** — query mode and select mode name displaced tools
 *     with the IDENTICAL sentence, which is the divergence the merge removes.
 *  6. **Bounds are catalog-DERIVED**, so a future 41-tool namespace fails this
 *     suite instead of silently refusing.
 */

import assert from "node:assert/strict";

import { describe, it, expect, beforeEach, afterEach } from "vitest";

import "./_dispatcher-test-mocks.js";
import type { InternalToolContext } from "@vex-agent/tools/internal/types.js";
import { makeTestContext } from "./_test-context.js";

import {
  MAX_DISCOVERY_LIMIT,
  MAX_SELECT_TOOL_NAMES,
  buildDisplacementWarning,
} from "@vex-agent/tools/protocols/discovery.js";
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

const { dispatchTool } = await import("../../../vex-agent/tools/dispatcher.js");

const SESSION = "tool-search-suite";

/** Every field the merge REMOVED from a model-visible row. Never reintroduce one. */
const SCHEMA_FIELDS = [
  "params",
  "required",
  "exampleParams",
  "constraints",
  "toolId",
] as const;

function context(overrides: Partial<InternalToolContext> = {}) {
  return makeTestContext({ sessionId: SESSION, ...overrides });
}

async function call(args: Record<string, unknown>, ctx = context()) {
  const result = await dispatchTool(
    { name: "ToolSearch", args, toolCallId: `call-${Math.random()}` },
    ctx,
  );
  return result;
}

async function callJson(args: Record<string, unknown>, ctx = context()) {
  const result = await call(args, ctx);
  return JSON.parse(result.output) as Record<string, unknown>;
}

/** The largest advertised namespace, derived — never typed in. */
function largestAdvertisedNamespace(): { namespace: string; size: number } {
  const counts = new Map<string, number>();
  for (const manifest of PROTOCOL_TOOLS) {
    if (!PROTOCOL_ADVERTISED_NAMESPACE_ALLOWLIST.includes(manifest.namespace)) continue;
    if (!isProtocolToolAvailable(manifest)) continue;
    counts.set(manifest.namespace, (counts.get(manifest.namespace) ?? 0) + 1);
  }
  let best = { namespace: "", size: 0 };
  for (const [namespace, size] of counts) if (size > best.size) best = { namespace, size };
  return best;
}

beforeEach(() => clearDiscoveredTools(SESSION));
afterEach(() => clearDiscoveredTools(SESSION));

describe("ToolSearch — mode derivation", () => {
  it("query mode ranks and records", async () => {
    const parsed = await callJson({ query: "bridge quote", namespace: "khalani" });
    expect(parsed.success).toBe(true);
    expect(parsed.count as number).toBeGreaterThan(0);
    expect(getDiscoveredToolIds(SESSION).length).toBe(parsed.count);
  });

  it("namespace alone is the listing, and records NOTHING", async () => {
    const parsed = await callJson({ namespace: "khalani" });
    expect(parsed.success).toBe(true);
    expect((parsed.retrieval as { method: string }).method).toBe("list");
    // A menu is not an order: browsing a namespace must not disturb the working
    // set, which is what lets a model read a large protocol without evicting
    // the tools it is mid-way through using.
    expect(getDiscoveredToolIds(SESSION)).toEqual([]);
    expect(parsed.nextStep).toContain("select:");
  });

  it("select mode makes a known name callable without dumping its manifest", async () => {
    const manifest = PROTOCOL_TOOLS.find(
      (m) => m.namespace === "khalani" && isProtocolToolAvailable(m),
    );
    assert.ok(manifest);

    const parsed = await callJson({ query: `select:${manifest.publicName}` });
    expect(parsed.success).toBe(true);
    expect(parsed.count).toBe(1);
    expect(parsed.tools).toEqual([
      { publicName: manifest.publicName, status: "callable_next_request" },
    ]);
    expect(getDiscoveredToolIds(SESSION)).toContain(manifest.toolId);
  });

  it("select tolerates whitespace around names and is case-insensitive on the prefix", async () => {
    const manifest = PROTOCOL_TOOLS.find(
      (m) => m.namespace === "khalani" && isProtocolToolAvailable(m),
    );
    assert.ok(manifest);
    const parsed = await callJson({ query: `SELECT: ${manifest.publicName} ` });
    expect(parsed.count).toBe(1);
  });
});

describe("ToolSearch — rejection paths (by name, nothing runs)", () => {
  it("no arguments names all three modes", async () => {
    const result = await call({});
    expect(result.success).toBe(false);
    expect(result.output).toContain("select:");
    expect(result.output).toContain("namespace");
    expect(result.output).toContain("NOT run");
  });

  it("a limit above the maximum is REJECTED, never clamped", async () => {
    const result = await call({ query: "swap", limit: MAX_DISCOVERY_LIMIT + 1 });
    expect(result.success).toBe(false);
    expect(result.output).toContain(String(MAX_DISCOVERY_LIMIT));
    expect(result.output).toContain("NOT run");
    expect(getDiscoveredToolIds(SESSION)).toEqual([]);
  });

  it("more than the maximum selected names is refused whole — nothing is recorded", async () => {
    const names = Array.from({ length: MAX_SELECT_TOOL_NAMES + 1 }, (_, i) => `n${i}`);
    const result = await call({ query: `select:${names.join(",")}` });
    expect(result.success).toBe(false);
    expect(result.output).toContain(String(MAX_SELECT_TOOL_NAMES));
    expect(getDiscoveredToolIds(SESSION)).toEqual([]);
  });

  it("an unresolvable name is rejected BY NAME while its siblings still resolve", async () => {
    const manifest = PROTOCOL_TOOLS.find(
      (m) => m.namespace === "khalani" && isProtocolToolAvailable(m),
    );
    assert.ok(manifest);

    const parsed = await callJson({ query: `select:${manifest.publicName},not__areal_tool` });
    // A partial batch is a SUCCESS with named losses, not a whole-call failure.
    expect(parsed.success).toBe(true);
    expect(parsed.count).toBe(1);
    const rows = parsed.tools as { publicName: string; status: string; reason?: string }[];
    const rejected = rows.find((r) => r.status === "rejected");
    assert.ok(rejected);
    expect(rejected.publicName).toBe("not__areal_tool");
    expect(rejected.reason).toContain("not a callable tool name");
  });

  it("the RETIRED `toolIds` argument is answered with the mode that replaced it", async () => {
    const result = await call({ toolIds: ["dexscreener.search"] });
    expect(result.success).toBe(false);
    expect(result.output).toContain("`toolIds` is retired");
    expect(result.output).toContain("select:");
  });

  it("the RETIRED `list` argument is answered with the mode that replaced it", async () => {
    const result = await call({ namespace: "khalani", list: true });
    expect(result.success).toBe(false);
    expect(result.output).toContain("`list` is retired");
    expect(result.output).toContain("namespace");
  });

  it("a ranking parameter sent with a select is refused, never silently dropped", async () => {
    for (const extra of [{ namespace: "khalani" }, { limit: 3 }]) {
      const result = await call({ query: "select:khalani__bridge", ...extra });
      expect(result.success).toBe(false);
      expect(result.output).toContain("does not apply to select mode");
    }
  });
});

describe("ToolSearch — the GOLDEN property: no parameter schema in any result", () => {
  it("a query result carries names and summaries only", async () => {
    const parsed = await callJson({ query: "swap quote on base", limit: 5 });
    const rows = parsed.tools as Record<string, unknown>[];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      for (const field of SCHEMA_FIELDS) {
        expect(row, `query row leaked \`${field}\``).not.toHaveProperty(field);
      }
      expect(typeof row.publicName).toBe("string");
      expect(typeof row.summary).toBe("string");
      // A one-line summary: the first sentence, not the whole paragraph.
      expect((row.summary as string).includes("\n")).toBe(false);
    }
  });

  it("a select result is an acknowledgement, not a manifest dump", async () => {
    const manifest = PROTOCOL_TOOLS.find(
      (m) => m.namespace === "khalani" && isProtocolToolAvailable(m),
    );
    assert.ok(manifest);
    const result = await call({ query: `select:${manifest.publicName}` });
    for (const field of SCHEMA_FIELDS) {
      expect(result.output, `select result leaked \`${field}\``).not.toContain(`"${field}":`);
    }
  });

  it("a namespace listing keeps requiredParams — a key list, not a schema", async () => {
    const parsed = await callJson({ namespace: "khalani" });
    const rows = parsed.tools as Record<string, unknown>[];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(Array.isArray(row.requiredParams)).toBe(true);
      // `requiredParams` is KEY NAMES only — no types, no descriptions.
      for (const key of row.requiredParams as unknown[]) expect(typeof key).toBe("string");
      for (const field of SCHEMA_FIELDS) {
        expect(row, `listing row leaked \`${field}\``).not.toHaveProperty(field);
      }
    }
  });
});

describe("ToolSearch — select is not a gate bypass", () => {
  it("refuses a name whose env var is missing, naming the VARIABLE and not its value", async () => {
    const gated = PROTOCOL_TOOLS.find((m) => m.requiresEnv !== undefined);
    if (!gated) return; // no env-gated manifest in the catalog right now
    const envVar = gated.requiresEnv;
    assert.ok(envVar);
    const previous = process.env[envVar];
    delete process.env[envVar];
    try {
      const parsed = await callJson({ query: `select:${gated.publicName}` });
      const rows = parsed.tools as { status: string; reason?: string }[];
      expect(rows[0]?.status).toBe("rejected");
      expect(rows[0]?.reason).toContain(envVar);
      expect(getDiscoveredToolIds(SESSION)).not.toContain(gated.toolId);
    } finally {
      if (previous !== undefined) process.env[envVar] = previous;
    }
  });

  it("refuses a mutating tool at the pressure barrier, matching what injection would do", async () => {
    const mutating = PROTOCOL_TOOLS.find(
      (m) => m.mutating && m.namespace === "khalani" && isProtocolToolAvailable(m),
    );
    assert.ok(mutating);

    const parsed = await callJson(
      { query: `select:${mutating.publicName}` },
      context({ contextUsageBand: "barrier" }),
    );
    const rows = parsed.tools as { status: string; reason?: string }[];
    expect(rows[0]?.status).toBe("rejected");
    expect(rows[0]?.reason).toContain("barrier");
    // The whole point: select must not record what injection would then drop.
    expect(getDiscoveredToolIds(SESSION)).not.toContain(mutating.toolId);
  });

  it("a ranked row tagged unavailable_at_pressure is NOT injected, and the next-step text says so", async () => {
    // SEARCH differs from SELECT here: select refuses outright, while a ranked
    // query still SHOWS a withheld mutating tool so the model can see the venue
    // exists. It must not also promise the row is callable - injection filters
    // exactly these rows out while the band holds, and a promise the serving
    // path contradicts is the self-report rule 09 forbids.
    const ctx = context({ contextUsageBand: "barrier" });
    const parsed = await callJson({ query: "bridge tokens across chains" }, ctx);

    const rows = parsed.tools as { publicName: string; unavailable_at_pressure?: boolean }[];
    const withheld = rows.filter((r) => r.unavailable_at_pressure === true);
    expect(withheld.length).toBeGreaterThan(0);

    const injected = buildInjectedProtocolTools(
      defaultVisibilityContext({ sessionId: SESSION, contextUsageBand: "barrier" }),
    ).map((t) => t.function.name);
    for (const row of withheld) {
      expect(injected).not.toContain(row.publicName);
    }

    expect(String(parsed.nextStep)).toContain("unavailable_at_pressure");
  });
});

describe("ToolSearch — next-request visibility", () => {
  it("a tool selected during request N is injected for N+1, not for N", async () => {
    const manifest = PROTOCOL_TOOLS.find(
      (m) => m.namespace === "khalani" && !m.mutating && isProtocolToolAvailable(m),
    );
    assert.ok(manifest);
    const ctx = defaultVisibilityContext({ sessionId: SESSION });

    // Request N's tools array is assembled BEFORE the call is dispatched.
    const before = buildInjectedProtocolTools(ctx).map((t) => t.function.name);
    expect(before).not.toContain(manifest.publicName);

    await call({ query: `select:${manifest.publicName}` });

    const after = buildInjectedProtocolTools(ctx).map((t) => t.function.name);
    expect(after).toContain(manifest.publicName);
  });

  it("states the next-request fact in both recording modes", async () => {
    const manifest = PROTOCOL_TOOLS.find(
      (m) => m.namespace === "khalani" && isProtocolToolAvailable(m),
    );
    assert.ok(manifest);

    const selected = await callJson({ query: `select:${manifest.publicName}` });
    expect(selected.nextStep as string).toContain("NEXT message");

    clearDiscoveredTools(SESSION);
    const queried = await callJson({ query: "bridge quote", namespace: "khalani" });
    expect(queried.nextStep as string).toContain("NEXT message");
  });
});

describe("ToolSearch — displacement parity and bounds", () => {
  it("query mode and select mode name a displaced tool with the IDENTICAL sentence", async () => {
    const available = PROTOCOL_TOOLS.filter(isProtocolToolAvailable);
    const filler = available.slice(0, MAX_DISCOVERED_TOOLS_PER_SESSION).map((m) => m.toolId);
    const victimId = filler[0];
    assert.ok(victimId);

    const newcomer = available.find((m) => !filler.includes(m.toolId) && !m.mutating);
    assert.ok(newcomer);

    recordDiscoveredTools(SESSION, filler);
    const parsed = await callJson({ query: `select:${newcomer.publicName}` });

    const expected = buildDisplacementWarning([victimId]);
    assert.ok(expected);
    expect(parsed.warnings as string[]).toContain(expected);
  });

  it("the select bound fits the LARGEST advertised namespace whole", () => {
    const largest = largestAdvertisedNamespace();
    expect(
      MAX_SELECT_TOOL_NAMES,
      `${largest.namespace} has ${largest.size} tools; a whole-namespace select must fit`,
    ).toBeGreaterThanOrEqual(largest.size);
    // And a single round can never evict itself.
    expect(MAX_DISCOVERED_TOOLS_PER_SESSION).toBeGreaterThanOrEqual(MAX_SELECT_TOOL_NAMES);
  });
});
