/**
 * The inventory ratchet and the eval-only `requiresEnv` sentinels.
 *
 * Both exist for the same failure: an eval process that measures a silently
 * reduced catalog and stores the result as quality. The sentinel helper is
 * exercised against an injected env object, never `process.env`, so this file
 * cannot change what any other eval sees.
 */

import { describe, expect, it } from "vitest";
import {
  PINNED_LIVE_CATALOG_TOOL_COUNT,
  liveCatalogToolCount,
} from "./live-catalog.js";
import {
  SENTINEL_VALUE,
  applyRequiresEnvSentinels,
  describeAppliedSentinels,
} from "./requires-env-sentinels.js";
import { liveProtocolManifests } from "./retrieval-eval-harness.js";
import { PROTOCOL_TOOLS } from "../../vex-agent/tools/protocols/catalog.js";

describe("live catalog inventory", () => {
  /**
   * A deliberate ratchet. Every baseline in `baselines/` was captured against
   * this inventory, so a tool added or removed without updating the constant
   * invalidates all of them silently. To update: change
   * PINNED_LIVE_CATALOG_TOOL_COUNT in `live-catalog.ts` in the same change that
   * moves the tool surface, then recapture the affected baselines.
   */
  it("matches the pinned tool count for this closure", () => {
    expect(liveCatalogToolCount()).toBe(PINNED_LIVE_CATALOG_TOOL_COUNT);
  });

  it("counts active advertised manifests, independently of process env", () => {
    const live = liveProtocolManifests();
    expect(live.every((manifest) => manifest.lifecycle === "active")).toBe(true);
    expect(live.length).toBe(PINNED_LIVE_CATALOG_TOOL_COUNT);
  });
});

describe("requiresEnv sentinels", () => {
  it("sets a non-secret sentinel for every unset requiresEnv name", () => {
    const env: NodeJS.ProcessEnv = {};
    const applied = applyRequiresEnvSentinels(PROTOCOL_TOOLS, env);

    const expected = [...new Set(
      PROTOCOL_TOOLS
        .filter((manifest) => manifest.lifecycle === "active")
        .map((manifest) => manifest.requiresEnv)
        .filter((name): name is string => name !== undefined),
    )];
    expect(applied.sort()).toEqual(expected.sort());
    expect(applied.length).toBeGreaterThan(0);
    for (const name of applied) expect(env[name]).toBe(SENTINEL_VALUE);
  });

  it("never overwrites a name that already carries a real value", () => {
    const name = PROTOCOL_TOOLS
      .filter((manifest) => manifest.lifecycle === "active")
      .map((manifest) => manifest.requiresEnv)
      .find((value): value is string => value !== undefined);
    expect(name).toBeDefined();

    const env: NodeJS.ProcessEnv = { [name as string]: "a-real-local-key" };
    const applied = applyRequiresEnvSentinels(PROTOCOL_TOOLS, env);
    expect(env[name as string]).toBe("a-real-local-key");
    expect(applied).not.toContain(name);
  });

  it("reports every applied name in full", () => {
    const env: NodeJS.ProcessEnv = {};
    const line = describeAppliedSentinels(applyRequiresEnvSentinels(PROTOCOL_TOOLS, env));
    for (const name of Object.keys(env)) expect(line).toContain(name);
    expect(line).not.toContain("...");
  });
});
