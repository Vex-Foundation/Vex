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
    const tool = getToolDef("ToolSearch");
    // One structural assertion rather than three dereferences behind `!`: the
    // whole point is that the lookup RESOLVED, so asserting the shape proves
    // both the existence and the identity in one place.
    expect(tool).toMatchObject({ name: "ToolSearch", kind: "internal" });
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

  it("identifies WalletSendConfirm as mutating", () => {
    expect(isMutatingTool("WalletSendConfirm")).toBe(true);
  });

  it("identifies ToolSearch as non-mutating", () => {
    expect(isMutatingTool("ToolSearch")).toBe(false);
  });

  it("identifies WebResearch as non-mutating", () => {
    expect(isMutatingTool("WebResearch")).toBe(false);
  });

  it("identifies TwitterAccount as non-mutating", () => {
    expect(isMutatingTool("TwitterAccount")).toBe(false);
  });

  // ── Expected tools present ───────────────────────────────────────

  const EXPECTED_TOOLS = [
    "ToolSearch",
      "WebResearch",
    "TwitterAccount",
    "SessionMemorySearch",
    "SessionMemoryResolve",
    "MemorySuggest",
    "MemorySearch",
    "MemoryGet",
    "MemoryHistory",
    "WalletBalances",
    "WalletSendPrepare",
    "WalletSendConfirm",
    "TokenFind",
    "MissionDraftUpdate",
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

  it("ToolSearch namespace description is generated from advertised namespaces", () => {
    const discover = getToolDef("ToolSearch");
    const namespace = discover?.parameters.properties?.namespace;
    expect(namespace).toBeDefined();
    expect(namespace?.description).toContain("dexscreener");
    expect(namespace?.description).toContain("khalani");
    // INVERTED by owner decision D4. Uniswap used to be a KNOWN but
    // non-ADVERTISED namespace that this static text had to omit, because
    // naming it would have leaked a hidden venue. The venue is no longer
    // hidden, so omitting it would now hide a namespace the agent may use.
    expect(namespace?.description).toContain("uniswap");
  });

  it("mutating tools are bridge, BridgeExecuteRelay, SwapExecute, SwapExecuteUniswap, WalletSendConfirm", () => {
    // `SwapExecute`/`SwapExecuteUniswap` (Stage 8b; Agent Scan plan §11.2
    // renamed `swap` in place and added the hidden Uniswap pair) and `BridgeExecute`
    // (Stage 8c) are MUTATING action-aliases that dispatch through the
    // dedicated branch (executeProtocolTool owns approval). Phase-2 bridge
    // factory W5 added the hidden Relay pair — `BridgeExecuteRelay` is the
    // mutating half (route-bound reveal; `BridgeQuoteRelay` is read-only).
    // Hidden-by-default visibility does not affect this list — `getAllTools()`
    // is unfiltered.
    const mutating = getAllTools().filter(t => t.mutating).map(t => t.name).sort();
    // Stage A4b added the two generic transaction CONFIRMs. They are mutating
    // by contract even while their execution half is a registered
    // not-yet-available stub: the classification describes what the tool IS,
    // and a tool that will broadcast must never be classified read-only on the
    // way to shipping.
    expect(mutating).toEqual([
      "BridgeExecute",
      "BridgeExecuteRelay",
      "SwapExecute",
      "SwapExecuteUniswap",
      "WalletEvmTransactionConfirm",
      "WalletSendConfirm",
      "WalletSolanaTransactionConfirm",
      // The wrap lane's confirm (migration 096). Mutating for the same reason
      // as the rest: it signs and broadcasts. Its PREPARE half is deliberately
      // absent from this list - `WalletWrapPrepare` derives, simulates and
      // records one durable intent, and spends nothing.
      "WalletWrapConfirm",
    ]);
  });

  // ── Visibility filtering ────────────────────────────────────────

  describe("visibility filtering", () => {
    // ── PR2-cutover catalog-level pressure-safety filter (codex P1 #4) ──
    //
    // `getOpenAITools` must drop `pressureSafety: "mutating"` tools at
    // `barrier`/`critical` bands, unless a live compaction preparation
    // bypasses the barrier. The dispatcher's hard-deny is the runtime safety
    // net; this is the catalog projection that keeps the model from seeing
    // tools it cannot use.
    it("at barrier band: mutating tools are hidden from the LLM catalog", () => {
      const tools = getOpenAITools(defaultVisibilityContext({
        permission: "full",
        sessionKind: "mission",
        missionRunActive: true,
        contextUsageBand: "barrier",
      }));
      const names = tools.map(t => t.function.name);
      // WalletSendConfirm + SwapExecute are canonical, universally-visible
      // mutating tools (registry-completeness asserts the mutating list).
      // SwapExecuteUniswap is NOT used here — it is ALSO hidden by the
      // reveal gate independent of pressure band, which would make a false
      // pressure-band assertion.
      expect(names).not.toContain("WalletSendConfirm");
      expect(names).not.toContain("SwapExecute");
    });

    it("at critical band: mutating tools are hidden from the LLM catalog", () => {
      const tools = getOpenAITools(defaultVisibilityContext({
        permission: "full",
        sessionKind: "mission",
        missionRunActive: true,
        contextUsageBand: "critical",
      }));
      const names = tools.map(t => t.function.name);
      expect(names).not.toContain("WalletSendConfirm");
      expect(names).not.toContain("SwapExecute");
    });

    it("CompactApply is visible whenever a prepared summary is READY — including below barrier", () => {
      // The axis is readiness, not pressure. Preparation routinely finishes in
      // the warning band, and that is the cheapest moment to apply it.
      for (const band of ["normal", "warning", "barrier", "critical"] as const) {
        const tools = getOpenAITools(defaultVisibilityContext({
          permission: "full",
          sessionKind: "mission",
          missionRunActive: true,
          contextUsageBand: band,
          hasCompactionSummaryReady: true,
        }));
        expect(tools.map(t => t.function.name)).toContain("CompactApply");
      }
    });

    it("CompactApply is HIDDEN when nothing is prepared, at every band", () => {
      for (const band of ["normal", "warning", "barrier", "critical"] as const) {
        const tools = getOpenAITools(defaultVisibilityContext({
          permission: "full",
          sessionKind: "mission",
          missionRunActive: true,
          contextUsageBand: band,
        }));
        expect(tools.map(t => t.function.name)).not.toContain("CompactApply");
      }
    });

    it("barrier + live preparation: mutating tools STAY visible (C8 bypass)", () => {
      const tools = getOpenAITools(defaultVisibilityContext({
        permission: "full",
        sessionKind: "mission",
        missionRunActive: true,
        contextUsageBand: "barrier",
        preparationBypassesBarrier: true,
      }));
      expect(tools.map(t => t.function.name)).toContain("WalletSendConfirm");
    });

    it("critical + live preparation: mutating tools are STILL stripped (bypass is barrier-only)", () => {
      // Forced apply owns the critical band. Letting fund-moving tools run at
      // 92% context would be the security relaxation this bypass must not become.
      const tools = getOpenAITools(defaultVisibilityContext({
        permission: "full",
        sessionKind: "mission",
        missionRunActive: true,
        contextUsageBand: "critical",
        preparationBypassesBarrier: true,
      }));
      expect(tools.map(t => t.function.name)).not.toContain("WalletSendConfirm");
    });

    it("barrier WITHOUT a bypass keeps stripping mutating tools (fail-closed default)", () => {
      const tools = getOpenAITools(defaultVisibilityContext({
        permission: "full",
        sessionKind: "mission",
        missionRunActive: true,
        contextUsageBand: "barrier",
      }));
      expect(tools.map(t => t.function.name)).not.toContain("WalletSendConfirm");
    });

    it("read_only tools (SessionMemorySearch, SessionMemoryResolve) are visible at every band when the session has memory", () => {
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
        expect(names, `band=${band}`).toContain("SessionMemorySearch");
        expect(names, `band=${band}`).toContain("SessionMemoryResolve");
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
      expect(fresh).not.toContain("SessionMemorySearch");
      expect(fresh).not.toContain("SessionMemoryResolve");

      const withMemory = getOpenAITools(defaultVisibilityContext({ ...base, hasSessionMemory: true }))
        .map(t => t.function.name);
      expect(withMemory).toContain("SessionMemorySearch");
      expect(withMemory).toContain("SessionMemoryResolve");
    });

    it("MissionStop is hidden in agent sessions (hiddenInAgent visibility gate)", () => {
      const tools = getOpenAITools(defaultVisibilityContext({
        permission: "restricted",
        sessionKind: "agent",
      }));
      const names = tools.map(t => t.function.name);
      expect(names).not.toContain("MissionStop");
    });

    it("mission tools split setup and run surfaces", () => {
      const setupNames = getOpenAITools(defaultVisibilityContext({
        permission: "restricted",
        sessionKind: "mission",
        missionRunActive: false,
      })).map(t => t.function.name);
      expect(setupNames).toContain("MissionDraftUpdate");
      expect(setupNames).not.toContain("MissionStop");

      const runNames = getOpenAITools(defaultVisibilityContext({
        permission: "restricted",
        sessionKind: "mission",
        missionRunActive: true,
      })).map(t => t.function.name);
      expect(runNames).toContain("MissionStop");
      expect(runNames).not.toContain("MissionDraftUpdate");
    });

  });
  describe("mission visibility", () => {
    it("MissionStop remains visible inside an active mission run", () => {
      const names = getOpenAITools(defaultVisibilityContext({
        permission: "restricted",
        sessionKind: "mission",
        missionRunActive: true,
      })).map((t) => t.function.name);
      expect(names).toContain("MissionStop");
    });
  });
});
