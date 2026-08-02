/**
 * Tool Map integrity — every registered agent ToolDef must appear in exactly
 * one `TOOL_MAP_CATEGORIES` entry, and every name in the map must resolve to
 * a registered ToolDef.
 *
 * Codex PR3 plan-review (round 1) required this scoping: the invariant
 * covers tools the LLM in agent runtime will see.
 */

import { describe, it, expect } from "vitest";

import {
  TOOL_MAP_CATEGORIES,
  defaultVisibilityContext,
  getAllTools,
  getToolDef,
  getVisibleToolDefs,
  getVisibleToolsByCategory,
  type ToolVisibilityContext,
} from "../../../vex-agent/tools/registry.js";

const AGENT_SURFACE_TOOL_NAMES = getAllTools().map(t => t.name);

const TOOL_MAP_NAMES = TOOL_MAP_CATEGORIES.flatMap(c => c.toolNames);

describe("TOOL_MAP_CATEGORIES integrity", () => {
  it("every agent-surface tool appears in exactly one category", () => {
    const orphans: string[] = [];
    for (const name of AGENT_SURFACE_TOOL_NAMES) {
      const occurrences = TOOL_MAP_NAMES.filter(n => n === name).length;
      if (occurrences !== 1) {
        orphans.push(`${name} (appears ${occurrences}× in TOOL_MAP_CATEGORIES)`);
      }
    }
    expect(orphans, `agent-surface tools NOT singly-categorized: ${orphans.join(", ")}`).toEqual([]);
  });

  it("every name in TOOL_MAP_CATEGORIES resolves to a registered ToolDef (no typos)", () => {
    const unresolved: string[] = [];
    for (const cat of TOOL_MAP_CATEGORIES) {
      for (const name of cat.toolNames) {
        if (!getToolDef(name)) {
          unresolved.push(`${name} (in category "${cat.label}")`);
        }
      }
    }
    expect(unresolved, `TOOL_MAP_CATEGORIES names not found in registry: ${unresolved.join(", ")}`).toEqual([]);
  });

  it("renders in declared order — no alphabetical sort within categories", () => {
    // Codex PR3 GREEN-LIGHT note (2): "Do not enforce alphabetical order
    // inside categories." Order carries model-priority intent (reads
    // before writes within Wallet, discover before execute within
    // Protocol meta-tools, etc).
    const wallet = TOOL_MAP_CATEGORIES.find(c => c.label === "Wallet transfers");
    expect(wallet?.toolNames).toEqual(["wallet_send_prepare", "wallet_send_confirm"]);
    // "prepare" before "confirm" is the 2-step transfer contract; if a
    // future refactor sorted alphabetically, "confirm" would come first
    // and lose the workflow signal.

    const protocolMeta = TOOL_MAP_CATEGORIES.find(c => c.label === "Protocol discovery/execution");
    expect(protocolMeta?.toolNames).toEqual(["discover_tools", "execute_tool"]);
  });
});

describe("plan_write visibility (requiresPlanMode + hiddenInMissionSetup:false)", () => {
  // Stage 0/3 decision: `plan_write` reuses the existing `requiresPlanMode`
  // gate and flips `hiddenInMissionSetup` to false, so it becomes visible in
  // mission SETUP exactly when plan-mode is on (co-authoring the plan alongside
  // the contract) and stays hidden when plan-mode is off.
  const isVisible = (ctx: ToolVisibilityContext): boolean =>
    getVisibleToolDefs(ctx).some(t => t.name === "plan_write");

  it("is HIDDEN in mission setup when plan-mode is OFF", () => {
    const ctx = defaultVisibilityContext({
      sessionKind: "mission",
      missionRunActive: false,
      planMode: false,
    });
    expect(isVisible(ctx)).toBe(false);
  });

  it("is VISIBLE in mission setup when plan-mode is ON", () => {
    const ctx = defaultVisibilityContext({
      sessionKind: "mission",
      missionRunActive: false,
      planMode: true,
    });
    expect(isVisible(ctx)).toBe(true);
  });
});

describe("Research category visibility in MISSION SETUP", () => {
  // The mission-setup prompt points the agent at the Research category
  // (`web_research`, `twitter_account`) as part of Capability Orientation.
  // That pointer is only honest if those tools actually project into the
  // mission-setup Tool Map when their env keys are configured. Both tools are
  // env-gated (TAVILY_API_KEY / RETTIWT_API_KEY) and carry no mission/band
  // visibility restriction, so with the keys set they must appear in a
  // mission-setup (missionRunActive=false) context.
  const ENV_KEYS = ["TAVILY_API_KEY", "RETTIWT_API_KEY"] as const;

  it("surfaces the Research category when TAVILY_API_KEY + RETTIWT_API_KEY are set", () => {
    const saved: Record<string, string | undefined> = {};
    for (const key of ENV_KEYS) saved[key] = process.env[key];
    try {
      process.env.TAVILY_API_KEY = "test-tavily-key";
      process.env.RETTIWT_API_KEY = "test-rettiwt-key";

      const ctx: ToolVisibilityContext = defaultVisibilityContext({
        permission: "restricted",
        sessionKind: "mission",
        missionRunActive: false,
        planMode: false,
        contextUsageBand: "normal",
        hasSessionMemory: false,
      });

      const categories = getVisibleToolsByCategory(ctx);
      const research = categories.find(c => c.label === "Research");
      expect(research, "Research category missing from mission-setup Tool Map").toBeDefined();
      expect(research?.toolNames).toContain("web_research");
      expect(research?.toolNames).toContain("twitter_account");
    } finally {
      for (const key of ENV_KEYS) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    }
  });
});
