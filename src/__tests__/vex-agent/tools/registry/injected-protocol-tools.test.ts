/**
 * Injected discovered protocol tools — name mapping, schema projection, and
 * the visibility gates (owner decision 2026-08-03, SPEC §7 Q1 / R1).
 *
 * The load-bearing property is BIJECTIVITY over the WHOLE catalog: a name the
 * provider accepts must map back to exactly one manifest, or a tool call could
 * be routed to the wrong tool. Every assertion below iterates `PROTOCOL_TOOLS`
 * rather than a sample, so a future manifest with a `__` or an empty dotted
 * segment fails here instead of in production.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import assert from "node:assert/strict";

import { PROTOCOL_TOOLS } from "@vex-agent/tools/protocols/catalog.js";
import { paramsToJsonSchema } from "@vex-agent/tools/registry/khalani.js";
import { describeParamGroupConstraints } from "@vex-agent/tools/protocols/runtime/params.js";
import { TOOLS } from "@vex-agent/tools/registry/lookup.js";
import {
  OPENAI_TOOL_NAME_PATTERN,
  buildInjectedProtocolTools,
  fromInjectedToolName,
  isInjectedToolNameShape,
  resolveInjectedProtocolTool,
  toInjectedToolName,
} from "@vex-agent/tools/registry/injected-protocol-tools.js";
import {
  MAX_DESCRIBE_TOOL_IDS,
  MAX_DISCOVERY_LIMIT,
} from "@vex-agent/tools/protocols/discovery.js";
import {
  MAX_DISCOVERED_TOOLS_PER_SESSION,
  clearDiscoveredTools,
  getDiscoveredToolIds,
  recordDiscoveredTools,
} from "@vex-agent/tools/registry/discovered-tools.js";
import { getOpenAITools } from "@vex-agent/tools/registry/openai-tools.js";
import { defaultVisibilityContext } from "@vex-agent/tools/registry/visibility.js";
import { getVisibleToolsByCategory } from "@vex-agent/tools/registry/tool-map.js";

const SESSION = "injected-tools-test-session";

const ctx = (overrides = {}) =>
  defaultVisibilityContext({ sessionId: SESSION, ...overrides });

beforeEach(() => clearDiscoveredTools(SESSION));
afterEach(() => clearDiscoveredTools(SESSION));

describe("injected tool names — bijective over the whole catalog", () => {
  it("every toolId maps to a legal OpenAI function name", () => {
    for (const manifest of PROTOCOL_TOOLS) {
      const name = toInjectedToolName(manifest.toolId);
      expect(
        OPENAI_TOOL_NAME_PATTERN.test(name),
        `${manifest.toolId} → ${name} is not a legal OpenAI function name`,
      ).toBe(true);
    }
  });

  it("every mapped name round-trips back to its toolId", () => {
    for (const manifest of PROTOCOL_TOOLS) {
      expect(fromInjectedToolName(toInjectedToolName(manifest.toolId))).toBe(manifest.toolId);
    }
  });

  it("the mapping is injective — no two toolIds collide on one name", () => {
    const names = PROTOCOL_TOOLS.map((m) => toInjectedToolName(m.toolId));
    expect(new Set(names).size).toBe(PROTOCOL_TOOLS.length);
  });

  it("no toolId contains the separator or an empty dotted segment (what would break the reverse map)", () => {
    for (const manifest of PROTOCOL_TOOLS) {
      expect(manifest.toolId.includes("__"), `${manifest.toolId} contains "__"`).toBe(false);
      for (const segment of manifest.toolId.split(".")) {
        expect(segment.length, `${manifest.toolId} has an empty segment`).toBeGreaterThan(0);
        expect(segment.startsWith("_") || segment.endsWith("_")).toBe(false);
      }
    }
  });

  it("no internal tool name collides with the injected namespace", () => {
    for (const tool of TOOLS) {
      expect(isInjectedToolNameShape(tool.name), `${tool.name} looks injected`).toBe(false);
    }
  });

  it("resolves an injected name back to its manifest and rejects a non-injected one", () => {
    const [first] = PROTOCOL_TOOLS;
    assert.ok(first);
    expect(resolveInjectedProtocolTool(toInjectedToolName(first.toolId))?.toolId).toBe(first.toolId);
    expect(resolveInjectedProtocolTool("execute_tool")).toBeUndefined();
    expect(resolveInjectedProtocolTool("nope__not__a__tool")).toBeUndefined();
  });
});

describe("injected schemas", () => {
  it("are the manifest's own projection, required flags included", () => {
    const manifest = PROTOCOL_TOOLS.find(
      (m) => m.namespace === "dexscreener" && m.params.some((p) => p.required),
    );
    assert.ok(manifest, "no dexscreener manifest with a required param");
    recordDiscoveredTools(SESSION, [manifest.toolId]);

    const injected = buildInjectedProtocolTools(ctx());
    const fn = injected.find((t) => t.function.name === toInjectedToolName(manifest.toolId));
    assert.ok(fn, `${manifest.toolId} was not injected`);

    expect(fn.function.description).toBe(manifest.description);
    expect(fn.function.parameters).toEqual(paramsToJsonSchema(manifest.params));
    expect(fn.function.parameters.required).toEqual(
      manifest.params.filter((p) => p.required).map((p) => p.key),
    );
  });

  it("append the manifest's cross-param group rules to the description", () => {
    // Every manifest declaring a group today is Jupiter's, and Jupiter is
    // env-gated out of injection — so the env this assertion needs is set for
    // the assertion, and restored after it.
    const previousKey = process.env.JUPITER_API_KEY;
    process.env.JUPITER_API_KEY = "test-key";
    try {
      assertInjectedDescriptionCarriesConstraints();
    } finally {
      if (previousKey === undefined) delete process.env.JUPITER_API_KEY;
      else process.env.JUPITER_API_KEY = previousKey;
    }
  });

  function assertInjectedDescriptionCarriesConstraints(): void {
    const manifest = PROTOCOL_TOOLS.find(
      (m) => describeParamGroupConstraints(m).length > 0,
    );
    assert.ok(manifest, "no manifest declares a param-group constraint");
    recordDiscoveredTools(SESSION, [manifest.toolId]);

    const injected = buildInjectedProtocolTools(ctx());
    const fn = injected.find((t) => t.function.name === toInjectedToolName(manifest.toolId));
    assert.ok(fn, `${manifest.toolId} was not injected`);

    expect(fn.function.description).toBe(
      `${manifest.description} ${describeParamGroupConstraints(manifest).join(" ")}`,
    );
    // The rule the model reads and the rule the runtime rejects with are one
    // sentence, produced by one function.
    for (const sentence of describeParamGroupConstraints(manifest)) {
      expect(fn.function.description).toContain(sentence);
    }
  }

  it("are appended POSITIONALLY LAST, after the internal tools", () => {
    const before = getOpenAITools(ctx());
    const manifest = PROTOCOL_TOOLS.find((m) => m.namespace === "dexscreener");
    assert.ok(manifest);
    recordDiscoveredTools(SESSION, [manifest.toolId]);

    const after = getOpenAITools(ctx());
    expect(after.slice(0, before.length)).toEqual(before);
    const last = after.at(-1);
    assert.ok(last);
    expect(last.function.name).toBe(toInjectedToolName(manifest.toolId));
  });

  it("leave the tools array untouched when nothing was discovered", () => {
    const withSession = getOpenAITools(ctx());
    const withoutSession = getOpenAITools(defaultVisibilityContext());
    expect(withSession).toEqual(withoutSession);
    expect(withSession.every((t) => !isInjectedToolNameShape(t.function.name))).toBe(true);
  });
});

describe("execute_tool retirement (owner decision 2026-08-03, staged)", () => {
  it("is absent from the model-visible tool list and Tool Map, while discover_tools stays", () => {
    const names = getOpenAITools(ctx()).map((t) => t.function.name);
    expect(names).not.toContain("execute_tool");
    expect(names).toContain("discover_tools");

    const mapped = getVisibleToolsByCategory(ctx()).flatMap((c) => c.toolNames);
    expect(mapped).not.toContain("execute_tool");
    expect(mapped).toContain("discover_tools");
  });

  it("stays REGISTERED — the dispatch route must survive for approval resume", () => {
    // An approved intent is re-dispatched by its STORED tool name
    // (`approval-runtime/post-tx/dispatch-approved.ts`). Deleting the
    // definition would strand every already-approved `execute_tool` call.
    expect(TOOLS.some((t) => t.name === "execute_tool")).toBe(true);
  });
});

describe("injection gates", () => {
  it("never injects a tool hidden by a missing env var", () => {
    const envGated = PROTOCOL_TOOLS.find((m) => m.requiresEnv !== undefined);
    if (!envGated) return; // no env-gated manifest in the catalog right now
    const envVar = envGated.requiresEnv;
    assert.ok(envVar);
    const previous = process.env[envVar];
    delete process.env[envVar];
    try {
      recordDiscoveredTools(SESSION, [envGated.toolId]);
      const names = buildInjectedProtocolTools(ctx()).map((t) => t.function.name);
      expect(names).not.toContain(toInjectedToolName(envGated.toolId));
    } finally {
      if (previous !== undefined) process.env[envVar] = previous;
    }
  });

  it("never injects the reveal-gated Uniswap pair for an unrevealed session", () => {
    recordDiscoveredTools(SESSION, ["uniswap.swap.quote", "uniswap.swap.execute"]);
    expect(buildInjectedProtocolTools(ctx())).toEqual([]);
  });

  it("drops mutating manifests at the pressure barrier, and restores them under the C8 bypass", () => {
    const mutating = PROTOCOL_TOOLS.find((m) => m.mutating && m.namespace === "khalani");
    assert.ok(mutating);
    recordDiscoveredTools(SESSION, [mutating.toolId]);

    expect(buildInjectedProtocolTools(ctx({ contextUsageBand: "barrier" }))).toEqual([]);
    expect(buildInjectedProtocolTools(ctx({ contextUsageBand: "critical" }))).toEqual([]);
    expect(
      buildInjectedProtocolTools(
        ctx({ contextUsageBand: "barrier", preparationBypassesBarrier: true }),
      ),
    ).toHaveLength(1);
    expect(buildInjectedProtocolTools(ctx())).toHaveLength(1);
  });
});

describe("session-scoped discovered set", () => {
  const ids = (n: number) => PROTOCOL_TOOLS.slice(0, n).map((m) => m.toolId);

  it("is empty for an absent or unknown session", () => {
    expect(getDiscoveredToolIds(undefined)).toEqual([]);
    expect(getDiscoveredToolIds("never-discovered")).toEqual([]);
  });

  it("INVARIANT: a full discovery round at the maximum allowed limit is never partially evicted", () => {
    // The agent sizes its own working set (`discover_tools` limit, max
    // MAX_DISCOVERY_LIMIT; `describe_tools` id array, max
    // MAX_DESCRIBE_TOOL_IDS). Every row of ONE such round must survive, or the
    // model loses tools it was shown in that very result.
    expect(MAX_DISCOVERED_TOOLS_PER_SESSION).toBeGreaterThanOrEqual(MAX_DISCOVERY_LIMIT);
    expect(MAX_DISCOVERED_TOOLS_PER_SESSION).toBeGreaterThanOrEqual(MAX_DESCRIBE_TOOL_IDS);

    const previousRound = ids(MAX_DISCOVERED_TOOLS_PER_SESSION);
    recordDiscoveredTools(SESSION, previousRound);
    const maxRound = PROTOCOL_TOOLS.slice(-MAX_DISCOVERY_LIMIT).map((m) => m.toolId);
    recordDiscoveredTools(SESSION, maxRound);

    const kept = getDiscoveredToolIds(SESSION);
    for (const toolId of maxRound) {
      expect(kept, `${toolId} was evicted from the round that just returned it`).toContain(toolId);
    }
    expect(kept).toHaveLength(MAX_DISCOVERED_TOOLS_PER_SESSION);
  });

  it("evicts oldest-first at the cap", () => {
    const many = ids(MAX_DISCOVERED_TOOLS_PER_SESSION + 3);
    recordDiscoveredTools(SESSION, many);

    const kept = getDiscoveredToolIds(SESSION);
    expect(kept).toHaveLength(MAX_DISCOVERED_TOOLS_PER_SESSION);
    expect([...kept]).toEqual(many.slice(3));
  });

  it("re-discovering a tool refreshes its position instead of duplicating it", () => {
    const [first, second, third] = ids(3);
    assert.ok(first !== undefined && second !== undefined && third !== undefined);
    recordDiscoveredTools(SESSION, [first, second, third]);
    recordDiscoveredTools(SESSION, [first]);

    expect([...getDiscoveredToolIds(SESSION)]).toEqual([second, third, first]);
  });

  it("keeps sessions independent", () => {
    recordDiscoveredTools(SESSION, ids(1));
    recordDiscoveredTools("other-session", ids(2).slice(1));
    try {
      expect([...getDiscoveredToolIds(SESSION)]).toEqual(ids(1));
    } finally {
      clearDiscoveredTools("other-session");
    }
  });
});
