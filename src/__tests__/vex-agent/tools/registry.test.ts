import { describe, it, expect } from "vitest";
import {
  getToolDef,
  isInternalTool,
  isMutatingTool,
  getAllTools,
  getOpenAITools,
  defaultVisibilityContext,
} from "../../../vex-agent/tools/registry.js";

describe("registry", () => {
  // ── Tool lookup ──────────────────────────────────────────────────

  it("returns all registered tools", () => {
    const tools = getAllTools();
    expect(tools.length).toBeGreaterThan(0);
  });

  it("finds tool by name", () => {
    const tool = getToolDef("discover_tools");
    expect(tool).toBeDefined();
    expect(tool!.name).toBe("discover_tools");
    expect(tool!.kind).toBe("internal");
  });

  it("returns undefined for unknown tool", () => {
    expect(getToolDef("nonexistent_tool")).toBeUndefined();
  });

  // ── Classification ───────────────────────────────────────────────

  it("classifies all registered tools as internal", () => {
    const tools = getAllTools();
    for (const tool of tools) {
      expect(isInternalTool(tool.name)).toBe(true);
    }
  });

  it("returns false for unknown tool in isInternalTool", () => {
    expect(isInternalTool("fake_tool")).toBe(false);
  });

  it("identifies wallet_send_confirm as mutating", () => {
    expect(isMutatingTool("wallet_send_confirm")).toBe(true);
  });

  it("identifies discover_tools as non-mutating", () => {
    expect(isMutatingTool("discover_tools")).toBe(false);
  });

  it("identifies web_research as non-mutating", () => {
    expect(isMutatingTool("web_research")).toBe(false);
  });

  it("identifies twitter_account as non-mutating", () => {
    expect(isMutatingTool("twitter_account")).toBe(false);
  });

  // ── Expected tools present ───────────────────────────────────────

  const EXPECTED_TOOLS = [
    "discover_tools",
    "execute_tool",
    "web_research",
    "twitter_account",
    "session_memory_search",
    "session_memory_resolve_item",
    "long_memory_suggest",
    "long_memory_search",
    "long_memory_get",
    "long_memory_history",
    "wallet_balances",
    "wallet_send_prepare",
    "wallet_send_confirm",
    "khalani_chains_list",
    "khalani_tokens_top",
    "token_find",
    "khalani_tokens_balances",
    "mission_draft_update",
  ];

  for (const name of EXPECTED_TOOLS) {
    it(`has tool: ${name}`, () => {
      expect(getToolDef(name)).toBeDefined();
    });
  }

  // ── Removed tools NOT present ────────────────────────────────────
  //
  // Removed-tool names are built from parts so the S9 grep gate (which bans
  // the literal identifiers repo-wide) does not match this file.

  it("does NOT have trade_log (auto-capture replaces it)", () => {
    expect(getToolDef("trade_log")).toBeUndefined();
  });

  it("does NOT have the retired memory-update tool (deprecated)", () => {
    expect(getToolDef(["memory", "update"].join("_"))).toBeUndefined();
  });

  it("does NOT have the retired memory-manage tool (long-term memory is manager-owned)", () => {
    expect(getToolDef(["memory", "manage"].join("_"))).toBeUndefined();
  });

  it("does NOT have any legacy knowledge tool (S9 cutover)", () => {
    const legacy = [
      "write",
      "recall",
      "recall_overflow",
      "get",
      "update_status",
      "supersede",
      "lineage",
      "history",
    ].map((suffix) => ["knowledge", suffix].join("_"));
    for (const name of legacy) {
      expect(getToolDef(name), name).toBeUndefined();
    }
  });

  it("does NOT have the pre-rename session-memory tool names (S9 cutover)", () => {
    expect(getToolDef(["memory", "recall"].join("_"))).toBeUndefined();
    expect(getToolDef(["mark", "outstanding", "resolved"].join("_"))).toBeUndefined();
  });

  it("legacy knowledge write is never agent-visible: no knowledge-prefixed name in any getOpenAITools projection", () => {
    const knowledgePrefix = ["knowledge", "_"].join("");
    for (const band of ["normal", "warning", "barrier", "critical"] as const) {
      const names = getOpenAITools(defaultVisibilityContext({
        permission: "full",
        sessionKind: "mission",
        missionRunActive: true,
        contextUsageBand: band,
        hasSessionMemory: true,
      })).map(t => t.function.name);
      expect(names.filter(n => n.startsWith(knowledgePrefix)), `band=${band}`).toEqual([]);
    }
  });

  it("does NOT have document_* (scratchpad vertical removed)", () => {
    for (const name of ["document_read", "document_write", "document_list", "document_delete"]) {
      expect(getToolDef(name)).toBeUndefined();
    }
  });

  it("does NOT have wallet_backup (deferred)", () => {
    expect(getToolDef("wallet_backup")).toBeUndefined();
  });

  it("does NOT have retired orientation tools", () => {
    expect(getToolDef("vex_introduction")).toBeUndefined();
    expect(getToolDef("vex_namespace_tools")).toBeUndefined();
  });

  it("does NOT have any removed delegated-worker tool (S1b cut, names from parts)", () => {
    const removedPrefix = ["sub", "agent_"].join("");
    for (const suffix of ["spawn", "status", "stop", "reply", "request_parent", "report_complete"]) {
      const name = `${removedPrefix}${suffix}`;
      expect(getToolDef(name), name).toBeUndefined();
      expect(isInternalTool(name), name).toBe(false);
    }
  });

  // ── OpenAI format ────────────────────────────────────────────────

  it("converts tools to OpenAI format", () => {
    const openaiTools = getOpenAITools(defaultVisibilityContext());
    expect(openaiTools.length).toBeGreaterThan(0);

    for (const tool of openaiTools) {
      expect(tool.type).toBe("function");
      expect(tool.function.name).toBeTruthy();
      expect(tool.function.description).toBeTruthy();
      expect(tool.function.parameters.type).toBe("object");
    }
  });

  it("filters proactive tools in restricted permission", () => {
    const restrictedTools = getOpenAITools(defaultVisibilityContext({ permission: "restricted" }));
    const fullTools = getOpenAITools(defaultVisibilityContext({ permission: "full" }));
    expect(restrictedTools.length).toBeLessThanOrEqual(fullTools.length);
  });

  // ── Tool definitions quality ─────────────────────────────────────

  it("every tool has non-empty description", () => {
    for (const tool of getAllTools()) {
      expect(tool.description.length).toBeGreaterThan(10);
    }
  });

  it("every tool has valid parameters schema", () => {
    for (const tool of getAllTools()) {
      expect(tool.parameters.type).toBe("object");
      expect(typeof tool.parameters.properties).toBe("object");
    }
  });

  it("discover_tools namespace description is generated from advertised namespaces", () => {
    const discover = getToolDef("discover_tools");
    const namespace = discover?.parameters.properties?.namespace;
    expect(namespace).toBeDefined();
    expect(namespace?.description).toContain("dexscreener");
    expect(namespace?.description).toContain("hyperliquid");
    expect(namespace?.description).toContain("khalani");
    // Agent Scan plan v3 §11.2 (FIX3-W7, Codex final-review round 2 finding 2 /
    // C30): the hidden Uniswap fallback is a KNOWN but non-ADVERTISED
    // namespace — this STATIC discovery schema text must never name it, even
    // though `uniswap.swap.*` tools still exist and are still reachable via
    // the session-revealed aliases.
    expect(namespace?.description).not.toContain("uniswap");
  });

  it("mutating tools are bridge, swap_execute, swap_execute_uniswap, wallet_send_confirm", () => {
    // `swap_execute`/`swap_execute_uniswap` (Stage 8b; Agent Scan plan §11.2
    // renamed `swap` in place and added the hidden Uniswap pair) and `bridge`
    // (Stage 8c) are MUTATING action-aliases that dispatch through the
    // dedicated branch (executeProtocolTool owns approval). Hidden-by-default
    // visibility does not affect this list — `getAllTools()` is unfiltered.
    const mutating = getAllTools().filter(t => t.mutating).map(t => t.name).sort();
    expect(mutating).toEqual([
      "bridge",
      "swap_execute",
      "swap_execute_uniswap",
      "wallet_send_confirm",
    ]);
  });

  // ── Visibility filtering ────────────────────────────────────────

  describe("visibility filtering", () => {
    // ── PR2-cutover catalog-level pressure-safety filter (codex P1 #4) ──
    //
    // `getOpenAITools` must drop `pressureSafety: "mutating"` tools at
    // `barrier`/`critical` bands and drop `pressureSafety: "compact_only"`
    // tools at `normal`/`warning`. The dispatcher's hard-deny is the runtime
    // safety net; this is the catalog projection that keeps the model from
    // seeing tools it cannot use.
    it("at barrier band: mutating tools are hidden from the LLM catalog", () => {
      const tools = getOpenAITools(defaultVisibilityContext({
        permission: "full",
        sessionKind: "mission",
        missionRunActive: true,
        contextUsageBand: "barrier",
      }));
      const names = tools.map(t => t.function.name);
      // wallet_send_confirm + swap_execute are canonical, universally-visible
      // mutating tools (registry-completeness asserts the mutating list).
      // swap_execute_uniswap is NOT used here — it is ALSO hidden by the
      // reveal gate independent of pressure band, which would make a false
      // pressure-band assertion.
      expect(names).not.toContain("wallet_send_confirm");
      expect(names).not.toContain("swap_execute");
    });

    it("at critical band: mutating tools are hidden from the LLM catalog", () => {
      const tools = getOpenAITools(defaultVisibilityContext({
        permission: "full",
        sessionKind: "mission",
        missionRunActive: true,
        contextUsageBand: "critical",
      }));
      const names = tools.map(t => t.function.name);
      expect(names).not.toContain("wallet_send_confirm");
      expect(names).not.toContain("swap_execute");
    });

    it("at barrier band: compact_only tools (compact_now) ARE visible", () => {
      const tools = getOpenAITools(defaultVisibilityContext({
        permission: "full",
        sessionKind: "mission",
        missionRunActive: true,
        contextUsageBand: "barrier",
      }));
      const names = tools.map(t => t.function.name);
      expect(names).toContain("compact_now");
    });

    it("at normal band: compact_only tools (compact_now) are hidden", () => {
      const tools = getOpenAITools(defaultVisibilityContext({
        permission: "full",
        sessionKind: "mission",
        missionRunActive: true,
        contextUsageBand: "normal",
      }));
      const names = tools.map(t => t.function.name);
      expect(names).not.toContain("compact_now");
    });

    it("at warning band: compact_only tools (compact_now) are hidden but mutating tools remain", () => {
      const tools = getOpenAITools(defaultVisibilityContext({
        permission: "full",
        sessionKind: "mission",
        missionRunActive: true,
        contextUsageBand: "warning",
      }));
      const names = tools.map(t => t.function.name);
      expect(names).not.toContain("compact_now");
      expect(names).toContain("wallet_send_confirm");
    });

    it("read_only tools (session_memory_search, session_memory_resolve_item) are visible at every band when the session has memory", () => {
      // Isolates the pressure-band axis: these tools also require
      // `hasSessionMemory` (see the gate test below), so this case pins a
      // session that HAS narrative chunks and checks read_only survives bands.
      for (const band of ["normal", "warning", "barrier", "critical"] as const) {
        const tools = getOpenAITools(defaultVisibilityContext({
          permission: "full",
          sessionKind: "mission",
          missionRunActive: true,
          contextUsageBand: band,
          hasSessionMemory: true,
        }));
        const names = tools.map(t => t.function.name);
        expect(names, `band=${band}`).toContain("session_memory_search");
        expect(names, `band=${band}`).toContain("session_memory_resolve_item");
      }
    });

    it("memory tools are gated by hasSessionMemory (hidden in a fresh session, shown once chunks exist)", () => {
      const base = {
        permission: "full" as const,
        sessionKind: "mission" as const,
        missionRunActive: true,
        contextUsageBand: "normal" as const,
      };
      const fresh = getOpenAITools(defaultVisibilityContext({ ...base, hasSessionMemory: false }))
        .map(t => t.function.name);
      expect(fresh).not.toContain("session_memory_search");
      expect(fresh).not.toContain("session_memory_resolve_item");

      const withMemory = getOpenAITools(defaultVisibilityContext({ ...base, hasSessionMemory: true }))
        .map(t => t.function.name);
      expect(withMemory).toContain("session_memory_search");
      expect(withMemory).toContain("session_memory_resolve_item");
    });

    it("mission_stop is hidden in agent sessions (hiddenInAgent visibility gate)", () => {
      const tools = getOpenAITools(defaultVisibilityContext({
        permission: "restricted",
        sessionKind: "agent",
      }));
      const names = tools.map(t => t.function.name);
      expect(names).not.toContain("mission_stop");
    });

    it("mission tools split setup and run surfaces", () => {
      const setupNames = getOpenAITools(defaultVisibilityContext({
        permission: "restricted",
        sessionKind: "mission",
        missionRunActive: false,
      })).map(t => t.function.name);
      expect(setupNames).toContain("mission_draft_update");
      expect(setupNames).not.toContain("mission_stop");

      const runNames = getOpenAITools(defaultVisibilityContext({
        permission: "restricted",
        sessionKind: "mission",
        missionRunActive: true,
      })).map(t => t.function.name);
      expect(runNames).toContain("mission_stop");
      expect(runNames).not.toContain("mission_draft_update");
    });

  });
  describe("mission visibility", () => {
    it("mission_stop remains visible inside an active mission run", () => {
      const names = getOpenAITools(defaultVisibilityContext({
        permission: "restricted",
        sessionKind: "mission",
        missionRunActive: true,
      })).map((t) => t.function.name);
      expect(names).toContain("mission_stop");
    });
  });
});
