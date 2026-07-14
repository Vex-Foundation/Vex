import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  clearHlPolicyProvider,
  registerHlPolicyProvider,
} from "../../../lib/hyperliquid-policy.js";
import {
  clearHlWorkspaceModeProvider,
  registerHlWorkspaceModeProvider,
} from "../../../lib/hyperliquid-workspace-mode.js";
import {
  buildHypervexingTurnStatePrompt,
  buildProtocolsPrompt,
  resetProtocolsPromptCache,
} from "@vex-agent/engine/prompts/protocols.js";
import { buildToolCatalogPrompt } from "@vex-agent/engine/prompts/tool-catalog.js";
import { getAllTools, getVisibleToolDefs, defaultVisibilityContext } from "@vex-agent/tools/registry.js";
import {
  getHypervexingAliasToolDef,
  resolveHypervexingAlias,
  HYPERVEXING_ALIAS_NAMES,
  HYPERVEXING_ALIAS_TARGETS,
} from "@vex-agent/tools/hypervexing-aliases.js";
import { getProtocolManifest } from "@vex-agent/tools/protocols/catalog.js";
import { PROTOCOL_TOOLS } from "@vex-agent/tools/protocols/catalog.js";
import { HYPERLIQUID_INTERNAL_TOOLS } from "@vex-agent/tools/registry/hyperliquid.js";

const SESSION_ID = "00000000-0000-4000-8000-000000000001";

function visibility(sessionId = SESSION_ID) {
  return defaultVisibilityContext({ sessionId });
}

beforeEach(() => {
  registerHlPolicyProvider(() => ({ policy: {}, version: "v1", provenance: "preferences" }));
  registerHlWorkspaceModeProvider((sessionId) => sessionId === SESSION_ID ? "hypervexing" : "normal");
  resetProtocolsPromptCache();
});

afterEach(() => {
  clearHlPolicyProvider();
  clearHlWorkspaceModeProvider();
  resetProtocolsPromptCache();
});

describe("Hypervexing mode-scoped aliases", () => {
  it("maps every alias to a real Hyperliquid manifest", () => {
    for (const [alias, toolId] of Object.entries(HYPERVEXING_ALIAS_TARGETS)) {
      expect(getProtocolManifest(toolId), `${alias} target missing: ${toolId}`).toBeDefined();
    }
  });

  it("shows the complete hot set only for the active session mode", () => {
    const hotNames = getVisibleToolDefs(visibility()).map((tool) => tool.name)
      .filter((name) => name.startsWith("hl_"));
    expect(hotNames).toEqual(HYPERVEXING_ALIAS_NAMES);
    expect(getVisibleToolDefs(visibility("00000000-0000-4000-8000-000000000002"))
      .some((tool) => tool.name.startsWith("hl_"))).toBe(false);
  });

  it("hl_open is ALWAYS in the hot set (owner decision: no release gate — every HL tool is live in-mode)", () => {
    const names = getVisibleToolDefs(visibility()).map((tool) => tool.name);
    expect(names).toContain("hl_open");
    expect(names).toContain("hl_close");
    expect(names).toContain("hl_set_stop");
    expect(names).toContain("hl_scan");
    expect(names).toContain("hl_candles");
    expect(names).toContain("hl_watch");
  });

  it("keeps the static protocols layer mode-invariant and projects only visible aliases into turn state", () => {
    expect(buildToolCatalogPrompt(visibility())).toContain("Hypervexing Hyperliquid hot set");
    expect(buildToolCatalogPrompt(visibility("00000000-0000-4000-8000-000000000002")))
      .not.toContain("Hypervexing Hyperliquid hot set");

    expect(buildProtocolsPrompt()).not.toContain("Hypervexing compact Hyperliquid index");

    const active = buildHypervexingTurnStatePrompt(visibility(), { sessionId: SESSION_ID });
    const inactive = buildHypervexingTurnStatePrompt(
      visibility("00000000-0000-4000-8000-000000000002"),
    );
    expect(active).toContain("Hypervexing compact Hyperliquid index");
    expect(active).toContain("Currently callable direct aliases: " + HYPERVEXING_ALIAS_NAMES.join(", "));
    expect(active).toContain("discover with `discover_tools(namespace=\"hyperliquid\")`");
    expect(active).toContain("Active Hyperliquid policy: leverage cap 3x; requireStopLoss=true; per-order notional <=20%; total notional <=100%.");
    // HL-first interpretation: a bare ticker in-workspace means the Hyperliquid
    // perp, not a same-name spot token on another chain.
    expect(active).toContain("means the HYPERLIQUID market by default");
    expect(active).not.toContain("hyperliquid.perp.twap");
    expect(active).not.toContain("Key params:");
    expect(inactive).toContain("Hypervexing workspace: not active.");
    expect(inactive).not.toContain("Hypervexing compact Hyperliquid index");
    expect(inactive).not.toContain("means the HYPERLIQUID market by default");
  });

  it("drops pressure-filtered aliases from the compact index alongside the Tool Map", () => {
    const barrier = visibility();
    barrier.contextUsageBand = "barrier";

    const mappedAliases = getVisibleToolDefs(barrier)
      .map((tool) => tool.name)
      .filter((name) => name.startsWith("hl_"));
    const prompt = buildHypervexingTurnStatePrompt(barrier);

    expect(prompt).toContain(`Currently callable direct aliases: ${mappedAliases.join(", ")}.`);
    expect(prompt).not.toContain("hl_close");
    expect(prompt).not.toContain("hl_open");
    expect(prompt).toContain("hl_exit");
  });

  it("substantially shrinks the mode-on prompt versus the legacy full capability index", () => {
    const legacyTargets = new Set(Object.values(HYPERVEXING_ALIAS_TARGETS));
    const legacySuffix = [
      "Hypervexing workspace: ACTIVE for this session.",
      "",
      "## Hypervexing compact Hyperliquid index",
      "",
      `The focused workspace exposes these direct aliases: ${HYPERVEXING_ALIAS_NAMES.join(", ")}. For every other Hyperliquid capability, call execute_tool directly with its toolId; aliases do not bypass any gate. These aliases are for YOU, not the user — never list or tabulate them in a reply; after entering the workspace, orient the user in one sentence (account state or what you can now do) and ask what they want.`,
      ...PROTOCOL_TOOLS
        .filter((tool) => tool.namespace === "hyperliquid" && !legacyTargets.has(tool.toolId))
        .map((tool) => {
          const required = tool.params.filter((param) => param.required).map((param) => param.key);
          const optional = tool.params.filter((param) => !param.required).map((param) => param.key);
          const keyParams = required.length === 0 && optional.length === 0
            ? "no params"
            : `required ${required.join(", ") || "none"}${optional.length > 0 ? `; optional ${optional.join(", ")}` : ""}`;
          return `- ${tool.toolId} — ${tool.description} Key params: ${keyParams}.`;
        }),
    ].join("\n");
    const currentSuffix = buildHypervexingTurnStatePrompt(visibility(), { sessionId: SESSION_ID });

    // Measured after the owner's gate removal + three market-analysis
    // aliases joined the hot set (hl_watch/hl_candles/hl_scan), then the
    // HL-first interpretation line was added: the exact sizes shifted, the
    // major-reduction contract (compact index stays a fraction of the legacy
    // full capability index) is what matters. Current ratio ~0.34.
    expect(currentSuffix.length).toBeLessThan(legacySuffix.length * 0.4);
    expect(
      currentSuffix.length,
      `legacy=${legacySuffix.length} chars, current=${currentSuffix.length} chars`,
    ).toBeLessThan(legacySuffix.length);
  });

  it("instructs same-turn entry for an explicit Hypervexing request", () => {
    expect(buildProtocolsPrompt()).toContain("call `hyperliquid_enter` in THAT turn");
    expect(buildProtocolsPrompt()).toContain("Do not merely describe the mode or ask a confirmation question.");
  });

  it("registers the always-visible safe-at-barrier workspace-entry tool", () => {
    expect(HYPERLIQUID_INTERNAL_TOOLS).toEqual([
      expect.objectContaining({
        name: "hyperliquid_enter",
        kind: "internal",
        mutating: false,
        pressureSafety: "safe_at_barrier",
      }),
    ]);
    expect(getAllTools().some((tool) => tool.name === "hyperliquid_enter")).toBe(true);
  });

  it("forwards the perp.markets search params through the hl_markets alias unchanged (W14)", () => {
    const def = getHypervexingAliasToolDef("hl_markets");
    expect(def?.parameters.properties).toHaveProperty("query");
    expect(def?.parameters.properties).toHaveProperty("limit");
    expect(resolveHypervexingAlias("hl_markets", { query: "cash", limit: 5 })).toEqual({
      toolId: "hyperliquid.perp.markets",
      params: { query: "cash", limit: 5 },
    });
  });

  it("keeps aliases outside the permanent registry and manifest census", () => {
    const permanentNames = new Set(getAllTools().map((tool) => tool.name));
    for (const alias of HYPERVEXING_ALIAS_NAMES) expect(permanentNames.has(alias)).toBe(false);
  });
});
