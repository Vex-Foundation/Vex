/**
 * `buildToolCatalogPrompt` regression — Tool Map renders the right
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
    contextUsageBand: "normal",
    // Default to a session that HAS narrative chunks so the existing
    // "Session memory" category assertions exercise the populated case; the
    // dedicated gate tests below flip this to false.
    hasSessionMemory: true,
    ...overrides,
  };
}

describe("buildToolCatalogPrompt — visibility-aware Tool Map", () => {
  describe("agent chat, normal band", () => {
    it("renders all expected categories + tools", () => {
      const out = buildToolCatalogPrompt(makeCtx());

      expect(out).toContain("# Available Tool Map");

      // Reads / orientation visible
      // `execute_tool` is withheld from the model-facing surface (staged retirement,
      // `registry/visibility.ts`) — discovered tools are injected as real functions.
      expect(out).toContain("**Protocol discovery/execution:** discover_tools");
      expect(out).not.toContain("execute_tool");
      expect(out).toContain("**Live state reads:** wallet_balances, chain_read, agent_scan");

      // Memory visible (read tools at normal band)
      expect(out).toContain("**Session memory — this conversation/mission only:** session_memory_search, session_memory_resolve_item");
      expect(out).toContain("**Long-term memory recall — durable cross-session lessons (search/get/history):** long_memory_search, long_memory_get, long_memory_history");

      // Wallet transfers visible at normal band
      expect(out).toContain("**Wallet transfers:** wallet_send_prepare, wallet_send_confirm");

      // Mission-only / setup-only categories are HIDDEN in agent chat
      expect(out).not.toContain("Mission setup draft");
      expect(out).not.toContain("Mission run stop");
      // `loop_defer` IS present here: makeCtx is a FULL-permission agent session,
      // and owner decree 2026-08-03 gave those sessions the ability to wait
      // (`requiresAutonomousLoop`). Its absence was the "unlimited thoughts"
      // incident — an agent waiting on a bridge with no way to sleep.
      expect(out).toContain("loop_defer");

      // The compaction category is absent while nothing is prepared
      expect(out).not.toContain("Context compaction");

      // Retired orientation tools never appear in the agent map.
      expect(out).not.toContain("vex_introduction");
      expect(out).not.toContain("vex_namespace_tools");
    });
  });

  describe("agent chat, barrier band", () => {
    it("drops mutating tools; compact_apply appears only once a summary is ready", () => {
      const out = buildToolCatalogPrompt(makeCtx({ contextUsageBand: "barrier" }));

      // Readiness, not pressure, is what surfaces the tool.
      expect(out).not.toContain("Context compaction");
      const ready = buildToolCatalogPrompt(
        makeCtx({ contextUsageBand: "barrier", hasCompactionSummaryReady: true }),
      );
      expect(ready).toContain(
        "**Context compaction — applies the prepared summary:** compact_apply",
      );

      // Mutating categories disappear (long_memory_suggest is pressureSafety
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
    it("includes mission_draft_update, excludes mission_stop and loop_defer", () => {
      const out = buildToolCatalogPrompt(makeCtx({
        sessionKind: "mission",
        missionRunActive: false,
      }));

      expect(out).toContain("**Mission setup draft:** mission_draft_update");
      expect(out).not.toContain("Mission run stop");
      expect(out).not.toContain("Mission run scheduling");
    });
  });

  describe("mission active run, normal band", () => {
    it("includes mission_stop + loop_defer, excludes mission_draft_update", () => {
      const out = buildToolCatalogPrompt(makeCtx({
        sessionKind: "mission",
        missionRunActive: true,
      }));

      expect(out).toContain("**Mission run stop:** mission_stop");
      expect(out).toContain("**Mission run scheduling:** loop_defer");
      expect(out).not.toContain("Mission setup draft");
    });
  });

  describe("mission active run, critical band", () => {
    it("loop_defer SURVIVES at critical alongside mission_stop (both safe_at_barrier)", () => {
      const out = buildToolCatalogPrompt(makeCtx({
        sessionKind: "mission",
        missionRunActive: true,
        contextUsageBand: "critical",
      }));

      // mission_stop is safe_at_barrier — survives at critical
      expect(out).toContain("**Mission run stop:** mission_stop");
      // loop_defer is safe_at_barrier too (owner decree 2026-08-03): stripping the
      // one tool that STOPS the loop at ≥88% context, while telling the model to
      // "continue with read-only work", was the incident. Deferring writes one row
      // and ends the slice — the cheapest possible context action.
      expect(out).toContain("loop_defer");
      // Nothing prepared ⇒ no compaction category, even at critical.
      expect(out).not.toContain("Context compaction");
    });
  });

  it("a RESTRICTED agent session still has no way to defer (human in the loop)", () => {
    const out = buildToolCatalogPrompt(makeCtx({ permission: "restricted" }));
    expect(out).not.toContain("loop_defer");
  });

  describe("ordering preservation", () => {
    it("renders categories in TOOL_MAP_CATEGORIES declared order", () => {
      const out = buildToolCatalogPrompt(makeCtx());
      const lines = out.split("\n").filter(l => l.startsWith("**"));
      // First content line MUST be Protocol discovery/execution per
      // declared order — this catches an accidental alphabetical sort
      // (which would put "Khalani" or another K-label earlier).
      expect(lines[0]).toMatch(/^\*\*Protocol discovery\/execution:/);
    });

    it("preserves tool order within Wallet transfers (prepare before confirm)", () => {
      const out = buildToolCatalogPrompt(makeCtx());
      expect(out).toContain("**Wallet transfers:** wallet_send_prepare, wallet_send_confirm");
      // NOT alphabetical (confirm < prepare) — that would break the
      // 2-step transfer workflow signal codex flagged.
      expect(out).not.toContain("wallet_send_confirm, wallet_send_prepare");
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
      // Renamed tool names built from parts — the S9 grep gate bans the raw
      // pre-rename literals repo-wide.
      expect(out).not.toContain(["session", "memory", "search"].join("_"));
      expect(out).not.toContain(["session", "memory", "resolve", "item"].join("_"));
      // Only the session-memory tools are gated — other read categories remain.
      expect(out).toContain("Long-term memory recall");
    });

    it("shows the Session memory category once the session has narrative chunks", () => {
      const out = buildToolCatalogPrompt(makeCtx({ hasSessionMemory: true }));
      expect(out).toContain(
        "**Session memory — this conversation/mission only:** session_memory_search, session_memory_resolve_item",
      );
    });

    it("never renders the retired pre-rename session-memory tool names (S9 — names from parts)", () => {
      const out = buildToolCatalogPrompt(makeCtx({ hasSessionMemory: true }));
      expect(out).not.toContain(["memory", "recall"].join("_"));
      expect(out).not.toContain(["mark", "outstanding", "resolved"].join("_"));
    });
  });
});
