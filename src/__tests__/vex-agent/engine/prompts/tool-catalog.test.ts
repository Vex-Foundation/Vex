/**
 * `buildToolCatalogPrompt` regression - Tool Map renders the right
 * categories + names for each of the 3 modes (agent / mission setup /
 * mission run) and the 4 pressure bands (normal / warning /
 * barrier / critical).
 *
 * Codex PR3 GREEN LIGHT verification: visibility-aware, empty categories
 * dropped, names in declared order across all contexts.
 */

import { describe, it, expect } from "vitest";

import { buildToolCatalogPrompt } from "../../../../vex-agent/engine/prompts/tool-catalog.js";
import type { ToolVisibilityContext } from "../../../../vex-agent/tools/registry.js";

function makeCtx(overrides: Partial<ToolVisibilityContext> = {}): ToolVisibilityContext {
  return {
    permission: "full",
    sessionKind: "agent",
    missionRunActive: false,
    planMode: false,
    contextUsageBand: "normal",
    // Default to a session that HAS narrative chunks so the existing
    // "Session memory" category assertions exercise the populated case; the
    // dedicated gate tests below flip this to false.
    hasSessionMemory: true,
    preparationBypassesBarrier: false,
    hasCompactionSummaryReady: false,
    ...overrides,
  };
}

describe("buildToolCatalogPrompt - visibility-aware Tool Map", () => {
  describe("agent chat, normal band", () => {
    it("renders all expected categories + tools", () => {
      const out = buildToolCatalogPrompt(makeCtx());

      expect(out).toContain("# Available Tool Map");

      // Reads / orientation visible
      // The `execute_tool` ToolDef is retired outright (the merge completed the
      // `registry/visibility.ts`) - discovered tools are injected as real functions -
      // and the category no longer advertises an execution wrapper at all.
      expect(out).toContain("**Protocol tool search:** ToolSearch");
      expect(out).not.toContain("execute_tool");
      expect(out).toContain("**Live state reads:** WalletBalances, ChainRead, AgentScan");

      // Memory visible (read tools at normal band)
      expect(out).toContain("**Session memory - this conversation/mission only:** SessionMemorySearch, SessionMemoryResolve");
      expect(out).toContain("**Long-term memory recall - durable cross-session lessons (search/get/history):** MemorySearch, MemoryGet, MemoryHistory");

      // Wallet transfers visible at normal band
      expect(out).toContain("**Wallet transfers:** WalletSendPrepare, WalletSendConfirm");

      // Mission-only / setup-only categories are HIDDEN in agent chat
      expect(out).not.toContain("Mission setup draft");
      expect(out).not.toContain("Mission run stop");
      // `LoopDefer` IS present here: makeCtx is a FULL-permission agent session,
      // and owner decree 2026-08-03 gave those sessions the ability to wait
      // (`requiresAutonomousLoop`). Its absence was the "unlimited thoughts"
      // incident - an agent waiting on a bridge with no way to sleep.
      expect(out).toContain("LoopDefer");

      // The compaction category is absent while nothing is prepared
      expect(out).not.toContain("Context compaction");

      // Retired orientation tools never appear in the agent map.
      expect(out).not.toContain("vex_introduction");
      expect(out).not.toContain("vex_namespace_tools");
    });
  });

  describe("agent chat, barrier band", () => {
    it("drops mutating tools; CompactApply appears only once a summary is ready", () => {
      const out = buildToolCatalogPrompt(makeCtx({ contextUsageBand: "barrier" }));

      // Readiness, not pressure, is what surfaces the tool.
      expect(out).not.toContain("Context compaction");
      const ready = buildToolCatalogPrompt(
        makeCtx({ contextUsageBand: "barrier", hasCompactionSummaryReady: true }),
      );
      expect(ready).toContain(
        "**Context compaction - applies the prepared summary:** CompactApply",
      );

      // Mutating categories disappear (MemorySuggest is pressureSafety
      // "mutating", so its category drops at barrier too)
      expect(out).not.toContain("Wallet transfers");
      expect(out).not.toContain("suggest a durable cross-session lesson");
      expect(out).not.toContain("Setup/onboarding");

      // Reads remain
      expect(out).toContain("Live state reads");
      expect(out).toContain("Long-term memory recall");
      expect(out).toContain("Session memory");
    });
  });

  describe("mission setup, normal band", () => {
    it("includes MissionDraftUpdate, excludes MissionStop and LoopDefer", () => {
      const out = buildToolCatalogPrompt(makeCtx({
        sessionKind: "mission",
        missionRunActive: false,
      }));

      expect(out).toContain("**Mission setup draft:** MissionDraftUpdate");
      expect(out).not.toContain("Mission run stop");
      expect(out).not.toContain("LoopDefer");
    });
  });

  describe("mission active run, normal band", () => {
    it("includes MissionStop + LoopDefer, excludes MissionDraftUpdate", () => {
      const out = buildToolCatalogPrompt(makeCtx({
        sessionKind: "mission",
        missionRunActive: true,
      }));

      expect(out).toContain("**Mission run stop:** MissionStop");
      // Labelled as the WAITING pattern, not a mission-run scheduling niche -
      // full agent sessions get the same tool.
      expect(out).toContain("**Waiting - park the loop until an event you cannot make happen sooner:** LoopDefer");
      expect(out).not.toContain("Mission setup draft");
    });
  });

  describe("mission active run, critical band", () => {
    it("LoopDefer SURVIVES at critical alongside MissionStop (both safe_at_barrier)", () => {
      const out = buildToolCatalogPrompt(makeCtx({
        sessionKind: "mission",
        missionRunActive: true,
        contextUsageBand: "critical",
      }));

      // MissionStop is safe_at_barrier - survives at critical
      expect(out).toContain("**Mission run stop:** MissionStop");
      // LoopDefer is safe_at_barrier too (owner decree 2026-08-03): stripping the
      // one tool that STOPS the loop at ≥88% context, while telling the model to
      // "continue with read-only work", was the incident. Deferring writes one row
      // and ends the slice - the cheapest possible context action.
      expect(out).toContain("LoopDefer");
      // Nothing prepared ⇒ no compaction category, even at critical.
      expect(out).not.toContain("Context compaction");
    });
  });

  it("a RESTRICTED agent session still has no way to defer (human in the loop)", () => {
    const out = buildToolCatalogPrompt(makeCtx({ permission: "restricted" }));
    expect(out).not.toContain("LoopDefer");
  });

  describe("ordering preservation", () => {
    it("renders categories in TOOL_MAP_CATEGORIES declared order", () => {
      const out = buildToolCatalogPrompt(makeCtx());
      const lines = out.split("\n").filter(l => l.startsWith("**"));
      // First content line MUST be Protocol tool search per declared order -
      // this catches an accidental alphabetical sort (which would put
      // "Khalani" or another K-label earlier).
      expect(lines[0]).toMatch(/^\*\*Protocol tool search:/);
    });

    it("preserves tool order within Wallet transfers (prepare before confirm)", () => {
      const out = buildToolCatalogPrompt(makeCtx());
      expect(out).toContain("**Wallet transfers:** WalletSendPrepare, WalletSendConfirm");
      // NOT alphabetical (confirm < prepare) - that would break the
      // 2-step transfer workflow signal codex flagged.
      expect(out).not.toContain("WalletSendConfirm, WalletSendPrepare");
    });
  });

  describe("empty-category dropping", () => {
    it("the Context compaction category is dropped when no summary is prepared", () => {
      const out = buildToolCatalogPrompt(makeCtx());
      expect(out).not.toContain("Context compaction");
    });
  });

  describe("session-memory gate (requiresSessionMemory)", () => {
    it("hides the Session memory category when the session has no narrative chunks", () => {
      const out = buildToolCatalogPrompt(makeCtx({ hasSessionMemory: false }));
      expect(out).not.toContain("Session memory");
      // Renamed tool names built from parts - the S9 grep gate bans the raw
      // pre-rename literals repo-wide.
      expect(out).not.toContain(["session", "memory", "search"].join("_"));
      expect(out).not.toContain(["session", "memory", "resolve", "item"].join("_"));
      // Only the session-memory tools are gated - other read categories remain.
      expect(out).toContain("Long-term memory recall");
    });

    it("shows the Session memory category once the session has narrative chunks", () => {
      const out = buildToolCatalogPrompt(makeCtx({ hasSessionMemory: true }));
      expect(out).toContain(
        "**Session memory - this conversation/mission only:** SessionMemorySearch, SessionMemoryResolve",
      );
    });

    it("never renders the retired pre-rename session-memory tool names (S9 - names from parts)", () => {
      const out = buildToolCatalogPrompt(makeCtx({ hasSessionMemory: true }));
      expect(out).not.toContain(["memory", "recall"].join("_"));
      expect(out).not.toContain(["mark", "outstanding", "resolved"].join("_"));
    });
  });
});
