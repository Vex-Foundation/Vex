import { describe, it, expect, beforeEach, afterEach } from "vitest";

import type { EngineContext, Permission, SessionKind } from "../../../../vex-agent/engine/types.js";
import {
  buildPromptStack,
  buildHypervexingTurnStatePrompt,
  buildProtocolsPrompt,
  resetProtocolsPromptCache,
  buildPermissionPrompt,
} from "../../../../vex-agent/engine/prompts/index.js";
import type { PromptStackOptions } from "../../../../vex-agent/engine/prompts/index.js";
import { buildRuntimeClockSnapshot } from "../../../../vex-agent/engine/runtime-clock.js";
import { PROTOCOL_ADVERTISED_NAMESPACE_ALLOWLIST, PROTOCOL_TOOLS } from "../../../../vex-agent/tools/protocols/catalog.js";
import { defaultVisibilityContext, getOpenAITools } from "../../../../vex-agent/tools/registry.js";
import {
  clearHlWorkspaceModeProvider,
  registerHlWorkspaceModeProvider,
} from "../../../../lib/hyperliquid-workspace-mode.js";

function makeContext(overrides: Partial<EngineContext> = {}): EngineContext {
  return {
    sessionId: "session-1",
    sessionKind: "agent",
    sessionPermission: "restricted",
    missionId: null,
    missionRunId: null,
    selectedEvmWallet: null,
    selectedSolanaWallet: null,
    walletPolicy: { kind: "none" },
    loadedDocuments: new Map(),
    ...overrides,
  };
}

/** Convenience: full prompt text (static + turn) for content assertions. */
function joinedStack(
  context: EngineContext = makeContext(),
  options: PromptStackOptions = {},
): string {
  const stack = buildPromptStack(context, options);
  return [...stack.staticLayers, ...stack.turnLayers].join("\n");
}

describe("prompt-stack", () => {
  beforeEach(() => {
    resetProtocolsPromptCache();
  });

  // ── Constant block present in every mode ────────────────────

  describe("constant layer always present", () => {
    const permissions: Permission[] = ["restricted", "full"];
    const kinds: SessionKind[] = ["agent", "mission"];

    for (const permission of permissions) {
      for (const kind of kinds) {
        it(`includes identity + tool model + protocols in ${kind}/${permission}`, () => {
          const joined = joinedStack(makeContext({ sessionPermission: permission, sessionKind: kind }));

          // Identity layer markers (P3 decomposition: split out of base.ts).
          expect(joined).toContain("# Identity");
          // The agent's own name is the fixed literal "Vex" (no more persona.md concept).
          expect(joined).toContain("Vex");
          expect(joined).toContain("## Your current aspect"); // P3 style contract: sole H1 per layer
          // Memory & Learning layer (P3: `# Memory and self-learning` +
          // tool-usage §5/§7 consolidated into one `# Memory & Learning` layer).
          expect(joined).toContain("# Memory & Learning");
          // Response Formatting is an EXPLICIT layer (P3: split out of base.ts,
          // heading title-cased). Present in every mode — GFM/image rules pinned.
          expect(joined).toContain("# Response Formatting");
          expect(joined).toContain("GitHub-Flavored Markdown");
          // Bounded markdown-affordances steering: token logos only from a
          // tool-provided logoUrl/imageUrl (never invented), explorer/dexscreener
          // links allowed. Replaces the old blanket "do not embed images" line.
          expect(joined).toContain("token logo as a Markdown image");
          expect(joined).toContain("never invent or guess an image URL");
          expect(joined).not.toContain("do not embed images");
          // Tools-are-internal presentation law (user-ordered after the live
          // hypervexing entry dumped an alias cheat-sheet at the user): tool
          // names/aliases are never enumerated to the user, in any mode.
          expect(joined).toContain("## Tools Are Internal Machinery");
          expect(joined).toContain("never enumerate or tabulate them to the user");

          // Tool usage markers
          expect(joined).toContain("discover_tools");
          expect(joined).toContain("execute_tool");
          expect(joined).toContain("2-step transfer rule");

          // Protocols marker
          expect(joined).toContain("# Available Protocol Namespaces");
        });
      }
    }
  });

  // ── D-LAYOUT: static/turn split + layer order ────────────────

  describe("static vs turn segmentation (D-LAYOUT)", () => {
    const FULL_OPTIONS: PromptStackOptions = {
      contextPressureBanner: "[Context pressure: elevated — 72% used]",
      resumePacket: "[Resume packet — generation 3, just compacted]",
      memorySection: "# Memory\n\n[Session memories: 2 chunk(s) across 1 compact(s). Tool: session_memory_search(semantic_intent, k≤5).]\n\n## Memory Routing\n\n- routing line",
      activePlanBlock: "# Active Plan\n\n1. do the thing",
      toolCatalogPrompt: "# Available Tool Map\n\n- wallet_balances",
      planOffNotice: "[Plan mode was switched off]",
    };

    it("static layers contain NO volatile markers", () => {
      const { staticLayers } = buildPromptStack(
        makeContext({ sessionKind: "mission", missionId: "m-1", missionRunId: "run-1" }),
        {
          ...FULL_OPTIONS,
          missionRunContext: { missionPromptContext: "# Mission: X", iterationCount: 5 },
        },
      );
      const staticJoined = staticLayers.join("\n");
      expect(staticJoined).not.toContain("# Runtime Clock");
      expect(staticJoined).not.toContain("# Memory Routing");
      expect(staticJoined).not.toContain("# Available Tool Map");
      expect(staticJoined).not.toContain("Iteration:");
      expect(staticJoined).not.toContain("Context pressure");
      expect(staticJoined).not.toContain("Resume packet");
      // Active-plan LAYER body absent (tool-usage legitimately NAMES the
      // `# Active Plan` heading in its reuse rule, so match the body).
      expect(staticJoined).not.toContain("1. do the thing");
      // Loaded Content absent when no documents are loaded.
      expect(staticJoined).not.toContain("# Loaded Content");
    });

    it("turn layers render in pinned order: clock → pressure → resume → # Memory(routing at end) → activePlan → Tool Map → mission turn-state → one-shots", () => {
      const { turnLayers } = buildPromptStack(
        makeContext({ sessionKind: "mission", missionId: "m-1", missionRunId: "run-1" }),
        {
          ...FULL_OPTIONS,
          missionRunContext: { missionPromptContext: "# Mission: X", iterationCount: 5 },
        },
      );
      const turnJoined = turnLayers.join("\n");
      const order = [
        "# Runtime Clock",
        "[Context pressure: elevated",
        "[Resume packet",
        "# Memory",
        "## Memory Routing", // P3 heading fix: H2 under the # Memory layer H1
        "# Active Plan",
        "# Available Tool Map",
        "Iteration: 5",
        "[Plan mode was switched off]",
      ];
      let lastIdx = -1;
      for (const marker of order) {
        const idx = turnJoined.indexOf(marker);
        expect(idx, `marker missing or out of order: ${marker}`).toBeGreaterThan(lastIdx);
        lastIdx = idx;
      }
    });

    it("keeps protocols static across workspace modes while mode state lives in the turn layer", () => {
      const sessionId = "workspace-session";
      let workspaceMode: "hypervexing" | "normal" = "hypervexing";
      registerHlWorkspaceModeProvider(() => workspaceMode);
      try {
        const activeMode = buildHypervexingTurnStatePrompt(
          defaultVisibilityContext({ sessionId }),
        );
        workspaceMode = "normal";
        const inactiveMode = buildHypervexingTurnStatePrompt(
          defaultVisibilityContext({ sessionId }),
        );
        const active = buildPromptStack(makeContext({ sessionId }), {
          hypervexingTurnStatePrompt: activeMode,
        });
        const inactive = buildPromptStack(makeContext({ sessionId }), {
          hypervexingTurnStatePrompt: inactiveMode,
        });

        expect(active.staticLayers).toEqual(inactive.staticLayers);
        expect(active.turnLayers.join("\n")).toContain("Hypervexing workspace: ACTIVE");
        expect(inactive.turnLayers.join("\n")).toContain("Hypervexing workspace: not active");
        expect(active.staticLayers.join("\n")).not.toContain("Hypervexing workspace: ACTIVE for this session.");
        expect(active.staticLayers.join("\n")).not.toContain("Hypervexing compact Hyperliquid index");
      } finally {
        clearHlWorkspaceModeProvider();
      }
    });

    it("the Iteration pin lives in the TURN layers (D-SPLIT-MISSION), frozen from missionRunContext", () => {
      const stack = buildPromptStack(
        makeContext({ sessionKind: "mission", missionId: "m-1", missionRunId: "run-1" }),
        {
          missionRunContext: {
            missionPromptContext: "# Mission: SOL DCA\n**Goal:** Accumulate 10 SOL",
            iterationCount: 5,
          },
        },
      );
      expect(stack.turnLayers.join("\n")).toContain("Iteration: 5");
      expect(stack.staticLayers.join("\n")).not.toContain("Iteration:");
      // Contract core stays static.
      expect(stack.staticLayers.join("\n")).toContain("SOL DCA");
    });

    it("base prompt no longer carries Loaded Content; it renders as the LAST static layer", () => {
      const { staticLayers } = buildPromptStack(makeContext({
        loadedDocuments: new Map([["long_memory:42", "# Strategy\nBuy low sell high"]]),
      }));
      // Not inside base (first layer)…
      expect(staticLayers[0]).not.toContain("# Loaded Content");
      // …but as the final static layer (END of the cache prefix).
      const last = staticLayers[staticLayers.length - 1];
      expect(last).toContain("# Loaded Content");
      expect(last).toContain("long_memory:42");
      expect(last).toContain("Buy low sell high");
    });

    it("grep-gate: separated static layers carry no stale positional 'above' references to turn-state blocks", () => {
      const { staticLayers } = buildPromptStack(makeContext());
      const staticJoined = staticLayers.join("\n");
      // The two reworded references (tool-usage.ts) now point at the turn state.
      expect(staticJoined).not.toContain("Tool Map above");
      expect(staticJoined).not.toContain("Memory Routing block above");
      expect(staticJoined).toContain("Tool Map provided in the turn state");
      expect(staticJoined).toContain("Memory Routing block in the turn state");
    });

    it("turn layers always start with the runtime clock; memorySection lands only when provided", () => {
      const without = buildPromptStack(makeContext());
      expect(without.turnLayers[0]).toContain("# Runtime Clock");
      expect(without.turnLayers.join("\n")).not.toContain("## Memory Routing");

      const withSection = buildPromptStack(makeContext(), {
        memorySection: "# Memory\n\n## Memory Routing\n\n- line",
      });
      expect(withSection.turnLayers.join("\n")).toContain("## Memory Routing");
    });
  });

  // ── Protocols generated from catalog ────────────────────────

  describe("protocols prompt", () => {
    it("mentions total tool count from actual catalog", () => {
      const prompt = buildProtocolsPrompt();
      const advertisedToolCount = PROTOCOL_TOOLS.filter((tool) =>
        PROTOCOL_ADVERTISED_NAMESPACE_ALLOWLIST.includes(tool.namespace),
      ).length;
      expect(prompt).toContain(`Total: ${advertisedToolCount} tools`);
    });

    it("contains all advertised namespaces from catalog", () => {
      const prompt = buildProtocolsPrompt();

      // Only advertised namespaces appear in the prompt — non-advertised
      // ones (e.g. reserved or temporarily disabled) are filtered out by
      // `buildProtocolsPrompt` via `PROTOCOL_ADVERTISED_NAMESPACE_ALLOWLIST`.
      const advertisedNamespacesWithTools = new Set(
        PROTOCOL_TOOLS
          .filter(t => (PROTOCOL_ADVERTISED_NAMESPACE_ALLOWLIST as readonly string[]).includes(t.namespace))
          .map(t => t.namespace),
      );

      for (const ns of advertisedNamespacesWithTools) {
        expect(prompt).toContain(`### ${ns}`); // P3 heading fix: namespace H3 under group H2
      }
    });

    it("keeps protocol navigation free of live availability state", () => {
      const prompt = buildProtocolsPrompt();

      expect(prompt).toContain("Tools: ");
      expect(prompt).toContain("cataloged.");
      expect(prompt).not.toContain(" active /");
      expect(prompt).not.toContain("Requires env:");
    });

    it("renders explicit product groups instead of heuristic families", () => {
      const prompt = buildProtocolsPrompt();
      expect(prompt).toContain("## Cross-chain"); // P3 heading fix: group H2 (was ###, inverted)
      expect(prompt).not.toContain("Families:");
    });

    it("marks namespaces with mutating tools", () => {
      const prompt = buildProtocolsPrompt();

      // Only advertised namespaces are rendered into the prompt — apply the
      // same filter when collecting "namespaces with mutating tools".
      const namespacesWithMutating = new Set(
        PROTOCOL_TOOLS
          .filter(t => t.mutating)
          .filter(t => (PROTOCOL_ADVERTISED_NAMESPACE_ALLOWLIST as readonly string[]).includes(t.namespace))
          .map(t => t.namespace),
      );

      for (const ns of namespacesWithMutating) {
        // The namespace section should mention mutating
        const nsSection = prompt.split(`### ${ns}`)[1]?.split("##")[0] ?? "";
        expect(nsSection).toContain("mutating");
      }
    });

    it("is not hardcoded — count changes with catalog", () => {
      const prompt = buildProtocolsPrompt();
      // The total count rendered in the prompt is the advertised tool count
      // (see `buildProtocolsPrompt`), not the full catalog size.
      const advertisedToolCount = PROTOCOL_TOOLS.filter((tool) =>
        (PROTOCOL_ADVERTISED_NAMESPACE_ALLOWLIST as readonly string[]).includes(tool.namespace),
      ).length;
      expect(prompt).toContain(String(advertisedToolCount));
    });
  });

  // ── Mission setup has same protocol knowledge ───────────────

  describe("mission setup vs full permission protocol knowledge", () => {
    it("has identical protocol block", () => {
      const setupStack = buildPromptStack(makeContext({
        sessionKind: "mission", sessionPermission: "restricted",
      }));
      const fullStack = buildPromptStack(makeContext({
        sessionKind: "mission", sessionPermission: "full", missionRunId: "run-1",
      }));

      // Both should have the same protocols prompt
      const setupProtocols = setupStack.staticLayers.find(s => s.includes("# Available Protocol Namespaces"));
      const fullProtocols = fullStack.staticLayers.find(s => s.includes("# Available Protocol Namespaces"));
      expect(setupProtocols).toBe(fullProtocols);

      // Both should have the same tool-model prompt (P3: `# Tool Usage` §1–3
      // became the `# Tool Model` layer).
      const setupToolModel = setupStack.staticLayers.find(s => s.includes("# Tool Model"));
      const fullToolModel = fullStack.staticLayers.find(s => s.includes("# Tool Model"));
      expect(setupToolModel).toBe(fullToolModel);
      expect(setupToolModel).toBeDefined();
    });

    it("differs only in policy and context", () => {
      const setupJoined = joinedStack(makeContext({
        sessionKind: "mission", sessionPermission: "restricted",
      }));
      const fullJoined = joinedStack(makeContext({
        sessionKind: "mission", sessionPermission: "full", missionRunId: "run-1",
      }));

      // Setup has setup-specific content
      expect(setupJoined).toContain("# Mission Setup");
      expect(setupJoined).not.toContain("# Mission Execution");

      // Full has run-specific content
      expect(fullJoined).toContain("# Mission Execution");
      expect(fullJoined).not.toContain("# Mission Setup");
    });
  });

  // ── Permission prompts ──────────────────────────────────────

  describe("permission prompts", () => {
    it("agent / restricted requires approval for mutations", () => {
      const prompt = buildPermissionPrompt({ mode: "agent", permission: "restricted" });
      expect(prompt).toContain("approval");
      expect(prompt).toContain("Mutating tools");
    });

    it("agent / full grants full authority", () => {
      const prompt = buildPermissionPrompt({ mode: "agent", permission: "full" });
      expect(prompt).toContain("bypasses only the generic session approval gate");
      expect(prompt).toContain("Hyperliquid mutations fail closed");
      expect(prompt).toContain("foreign egress always requires approval");
    });

    it("mission / restricted requires approval and supports loop_defer", () => {
      const prompt = buildPermissionPrompt({ mode: "mission", permission: "restricted" });
      expect(prompt).toContain("approval");
      expect(prompt).toContain("loop_defer");
    });

    it("mission / full grants full authority", () => {
      const prompt = buildPermissionPrompt({ mode: "mission", permission: "full" });
      expect(prompt).toContain("bypasses only the generic session approval gate");
      expect(prompt).toContain("Per-tool\n  policies always apply");
    });
  });

  // ── Contextual layers ───────────────────────────────────────

  describe("contextual layers", () => {
    it("agent mode includes agent prompt", () => {
      const joined = joinedStack(makeContext({ sessionKind: "agent" }));
      expect(joined).toContain("# Agent Mode");
    });

    it("mission setup includes setup prompt", () => {
      const joined = joinedStack(makeContext({
        sessionKind: "mission", missionId: "m-1",
      }));
      expect(joined).toContain("# Mission Setup");
      expect(joined).not.toContain("# Mission Execution");
      // The standing execution lock rides the setup layer: pre-acceptance,
      // every on-chain mutation is gate-blocked and the model must say so
      // instead of inventing workarounds.
      expect(joined).toContain("Execution lock (standing rule)");
    });

    it("mission run includes run prompt", () => {
      const joined = joinedStack(makeContext({
        sessionKind: "mission", missionId: "m-1", missionRunId: "run-1",
      }));
      expect(joined).toContain("# Mission Execution");
      expect(joined).not.toContain("# Mission Setup");
      // Setup-only: the execution lock must not leak into an active run.
      expect(joined).not.toContain("Execution lock (standing rule)");
    });

    it("mission setup with context shows draft state", () => {
      const joined = joinedStack(
        makeContext({ sessionKind: "mission" }),
        {
          missionSetupContext: {
            currentDraft: { title: "SOL DCA", goal: "Accumulate SOL" },
            missingFields: ["capitalSource", "startingCapital"],
          },
        },
      );
      expect(joined).toContain("SOL DCA");
      expect(joined).toContain("Still Missing");
      expect(joined).toContain("capitalSource");
      expect(joined).toContain("Stop conditions are user-owned contract terms");
      // Puzzle 04: prompt no longer instructs the model about
      // `stopConditionsAccepted=true` — acceptance is host-only. The
      // mission-setup prompt instead points the model at the host
      // `Accept contract` step.
      // Wave-3 P4: one authoritative activation-sequence rule replaces the
      // old standalone acceptance sentence.
      expect(joined).toContain("click Accept contract");
      expect(joined).toContain("Only after that acceptance does the host show Start mission");
    });

    it("mission run with context shows mission contract", () => {
      const joined = joinedStack(
        makeContext({ sessionKind: "mission", missionRunId: "run-1" }),
        {
          missionRunContext: {
            missionPromptContext: "# Mission: SOL DCA\n**Goal:** Accumulate 10 SOL",
            iterationCount: 5,
          },
        },
      );
      expect(joined).toContain("SOL DCA");
      expect(joined).toContain("Iteration: 5");
    });

  });

  // ── Base prompt ─────────────────────────────────────────────

  describe("base prompt", () => {
    it("includes session context", () => {
      const joined = joinedStack(makeContext({ sessionId: "test-session" }));
      expect(joined).toContain("test-session");
    });

    it("includes runtime clock context for session and mission timing (turn layers)", () => {
      const runtimeClock = buildRuntimeClockSnapshot({
        now: new Date("2026-05-03T08:39:18.126Z"),
        timezone: "UTC",
        sessionStartedAt: "2026-05-03T08:01:02.000Z",
        missionRunStartedAt: "2026-05-03T08:10:00.000Z",
        missionDeadline: "2026-05-03T14:10:00.000Z",
      });
      const stack = buildPromptStack(
        makeContext({
          sessionKind: "mission",
          missionId: "m-1",
          missionRunId: "run-1",
          sessionStartedAt: "2026-05-03T08:01:02.000Z",
          missionRunStartedAt: "2026-05-03T08:10:00.000Z",
          missionDeadline: "2026-05-03T14:10:00.000Z",
        }),
        { runtimeClock },
      );
      const turnJoined = stack.turnLayers.join("\n");

      expect(turnJoined).toContain("# Runtime Clock");
      expect(turnJoined).toContain("Current time UTC: 2026-05-03T08:39:18.126Z");
      expect(turnJoined).toContain("Session started: 2026-05-03T08:01:02.000Z (elapsed: 38m 16s)");
      expect(turnJoined).toContain("Mission run started: 2026-05-03T08:10:00.000Z (elapsed: 29m 18s)");
      expect(turnJoined).toContain("Mission deadline: 2026-05-03T14:10:00.000Z (in 5h 30m)");
      expect(turnJoined).toContain("loop_defer(after_ms, reason)");
      // The volatile clock must never leak into the static prefix.
      expect(stack.staticLayers.join("\n")).not.toContain("# Runtime Clock");
    });

    it("includes loaded content blocks (e.g. long_memory_get injections)", () => {
      const joined = joinedStack(makeContext({
        loadedDocuments: new Map([["long_memory:42", "# Strategy\nBuy low sell high"]]),
      }));
      expect(joined).toContain("# Loaded Content");
      expect(joined).toContain("long_memory:42");
      expect(joined).toContain("Buy low sell high");
    });
  });

  // ── Dynamic aspect injection ────────────────────────────────

  describe("base prompt — dynamic aspect", () => {
    /**
     * Aspect narration in base.ts is modal: only the currently active mode's
     * aspect lands in the prompt. Prevents model from reading about modes it
     * can't reach from this session.
     */
    it("AGENT aspect: only teacher/collaborator lines, no MISSION narrative", () => {
      const joined = joinedStack(makeContext({ sessionKind: "agent" }));
      expect(joined).toContain("AGENT");
      expect(joined).toContain("teacher, collaborator");
      expect(joined).not.toContain("MISSION SETUP");
      expect(joined).not.toContain("MISSION RUN");
    });

    it("MISSION SETUP aspect: planner lines, no AGENT / MISSION RUN narrative", () => {
      const joined = joinedStack(makeContext({ sessionKind: "mission" }));
      expect(joined).toContain("MISSION SETUP");
      expect(joined).toContain("planner");
      // AGENT aspect narrative absent — we only check the aspect-section label.
      expect(joined).not.toContain("teacher, collaborator");
      expect(joined).not.toContain("MISSION RUN");
    });

    it("MISSION RUN aspect: executor lines, no SETUP / AGENT narrative", () => {
      const joined = joinedStack(makeContext({
        sessionKind: "mission", missionId: "m-1", missionRunId: "run-1",
      }));
      expect(joined).toContain("MISSION RUN");
      expect(joined).toContain("executor");
      expect(joined).toContain("mission_stop");
      expect(joined).toContain("user-approved stop condition");
      expect(joined).toContain("loop_defer");
      expect(joined).not.toContain("teacher, collaborator");
      expect(joined).not.toContain("planner");
    });
  });

  // ── DeFi safety rules ──────────────────────────────────────

  describe("DeFi safety rules in prompt", () => {
    it("contains gas reserve rule", () => {
      const joined = joinedStack(makeContext());
      expect(joined).toContain("Gas reserve on native tokens");
      expect(joined).toContain("balance minus gas reserve");
    });

    it("contains fresh balance rule", () => {
      const joined = joinedStack(makeContext());
      expect(joined).toContain("Fresh balance before each mutation");
    });

    it("contains quote / preview before mutation rule (PR3 reorg)", () => {
      // PR3-clarity rephrased the rule as "Quote / preview before mutation";
      // P3 decomposition moved it into the `# Safety Contract` layer. The
      // contract (read-only dryRun pass first) is preserved.
      const joined = joinedStack(makeContext());
      expect(joined).toMatch(/Quote\s*\/\s*preview before mutation/i);
    });

    it("contains address-first rule", () => {
      const joined = joinedStack(makeContext());
      expect(joined).toContain("Address-first for EVM mutations");
      expect(joined).toContain("khalani.tokens.search");
    });

    it("khalani is canonical resolver in protocols section, kyberswap is not primary", () => {
      const prompt = buildProtocolsPrompt();
      // kyberswap section should reference khalani as resolver, not itself
      const kyberSection = prompt.split("### kyberswap")[1]?.split("##")[0] ?? "";
      expect(kyberSection).toContain("khalani");
      expect(kyberSection).not.toContain("kyberswap.tokens.search");
    });

  });

  // ── P3 decomposition invariants ─────────────────────────────
  //
  // The canonical `# Safety Contract` layer renders in EVERY mode — this is the
  // precondition that lets the mode.ts (now execution-policy.ts) FULL variants
  // drop their duplicated gas-reserve / fresh-balance bullets (Codex P2 add d).
  describe("Safety Contract renders in EVERY mode", () => {
    const variants: Array<{ name: string; ctx: EngineContext }> = [
      { name: "agent/restricted", ctx: makeContext({ sessionKind: "agent", sessionPermission: "restricted" }) },
      { name: "agent/full", ctx: makeContext({ sessionKind: "agent", sessionPermission: "full" }) },
      { name: "mission-setup", ctx: makeContext({ sessionKind: "mission", sessionPermission: "restricted", missionId: "m-1" }) },
      { name: "mission-run", ctx: makeContext({ sessionKind: "mission", sessionPermission: "full", missionId: "m-1", missionRunId: "run-1" }) },
    ];

    for (const { name, ctx } of variants) {
      it(`${name} static prefix carries the canonical safety section + its rules`, () => {
        const staticJoined = buildPromptStack(ctx).staticLayers.join("\n");
        expect(staticJoined).toContain("# Safety Contract");
        expect(staticJoined).toContain("Gas reserve on native tokens");
        expect(staticJoined).toContain("Fresh balance before each mutation");
        expect(staticJoined).toContain("Address-first for EVM mutations");
        expect(staticJoined).toMatch(/Quote\s*\/\s*preview before mutation/i);
      });
    }
  });

  // Execution Policy is authority-first (slot 2, right after Identity) and no
  // longer restates the safety bullets — those now live only in the Safety
  // Contract layer above (P2 locked requirement 1 + mode.ts dup removal).
  describe("Execution Policy layer (authority-only, moved to slot 2)", () => {
    it("renders as the 2nd static layer, right after Identity", () => {
      const { staticLayers } = buildPromptStack(makeContext());
      expect(staticLayers[0]).toContain("# Identity");
      expect(staticLayers[1]).toContain("# Execution Policy");
    });

    // Codex P3 review: the slot-2 claim must hold in the RAW prompt text, not
    // just the layers array — each layer emits exactly one H1 (style contract),
    // so `# Execution Policy` is the literal second top-level heading the model
    // reads. Guards against a layer sneaking extra H1s back in (identity.ts
    // internals are H2 for this reason).
    for (const kind of ["agent", "mission"] as const) {
      it(`raw static-prefix H1 order starts Identity → Execution Policy (${kind})`, () => {
        const { staticLayers } = buildPromptStack(
          makeContext({ sessionKind: kind, ...(kind === "mission" ? { missionId: "m-1" } : {}) }),
          // Persona block ON so the optional identity section is exercised too.
          undefined,
        );
        const h1s = staticLayers
          .join("\n")
          .split("\n")
          .filter((line) => line.startsWith("# "));
        expect(h1s[0]).toBe("# Identity");
        expect(h1s[1]).toContain("# Execution Policy");
      });
    }

    it("identity layer emits exactly ONE top-level heading even with a user profile section", () => {
      const { staticLayers } = buildPromptStack(
        makeContext({ userInstructionsMd: "Tone: concise, dry, no emoji." }),
      );
      const identityH1s = staticLayers[0]
        .split("\n")
        .filter((line) => line.startsWith("# "));
      expect(identityH1s).toEqual(["# Identity"]);
    });

    it("FULL permission variants no longer duplicate the safety bullets", () => {
      const agentFull = buildPermissionPrompt({ mode: "agent", permission: "full" });
      const missionFull = buildPermissionPrompt({ mode: "mission", permission: "full" });
      for (const policy of [agentFull, missionFull]) {
        // Authority marker (wave-3 P3 rewording: full bypasses ONLY the
        // generic session approval gate; per-tool policy always applies).
        expect(policy).toContain("bypasses only the generic session approval gate");
        // The duplicated safety bullets are gone (single home = Safety Contract).
        expect(policy).not.toContain("verify before large trades");
        expect(policy).not.toContain("reserve gas for at least one");
        expect(policy).not.toContain("refresh wallet balances");
        // Instead it points at the single safety home.
        expect(policy).toContain("Safety Contract");
      }
    });
  });

  // The agent mode-core carries a UNIQUE anti-drift instruction that no other
  // layer states — it must survive the decomposition (Codex P2 add e).
  describe("agent mode-core anti-drift instruction preserved (P3 requirement e)", () => {
    it("keeps the unique 'don't drift into autonomous monitoring/mission drafting' line", () => {
      const joined = joinedStack(makeContext({ sessionKind: "agent" }));
      expect(joined).toContain(
        "Do not turn an agent answer into autonomous monitoring, mission drafting, or multi-step research unless the user asks for that workflow",
      );
    });
  });

  // ── Env-aware availability in protocols prompt ──────────────────

  describe("protocols prompt — env awareness", () => {
    const ENV_KEYS = ["JUPITER_API_KEY", "POLYMARKET_API_KEY"] as const;
    const original: Record<string, string | undefined> = {};

    beforeEach(() => {
      for (const k of ENV_KEYS) original[k] = process.env[k];
      resetProtocolsPromptCache();
    });

    afterEach(() => {
      for (const k of ENV_KEYS) {
        if (original[k] === undefined) delete process.env[k];
        else process.env[k] = original[k];
      }
      resetProtocolsPromptCache();
    });

    it("static protocols layer is deterministic: no live env/availability info even when a namespace is fully gated", () => {
      // Wave-3 P2: the static prefix must be KV-cache stable, so live
      // availability ("N active") and env hints moved out; discovery and the
      // Tool Map carry the live picture.
      delete process.env.JUPITER_API_KEY;
      resetProtocolsPromptCache();
      const prompt = buildProtocolsPrompt();
      const solanaSection = prompt.split("### solana")[1]?.split("##")[0] ?? "";
      expect(solanaSection).toContain("cataloged.");
      expect(solanaSection).not.toContain("Requires env:");
      expect(solanaSection).not.toContain("active");
    });

    it("does not render 'Requires env' hint when env is present", () => {
      process.env.JUPITER_API_KEY = "test-jupiter-key";
      resetProtocolsPromptCache();
      const prompt = buildProtocolsPrompt();
      const solanaSection = prompt.split("### solana")[1]?.split("##")[0] ?? "";
      expect(solanaSection).not.toContain("Requires env:");
    });
  });

  // ── Stack structure ───────────────────────────────────────

  describe("stack structure", () => {
    it("returns the {staticLayers, turnLayers} shape with separate sections", () => {
      const stack = buildPromptStack(makeContext());
      expect(Array.isArray(stack.staticLayers)).toBe(true);
      expect(Array.isArray(stack.turnLayers)).toBe(true);
      // Static minimum (P3 authority-first order): identity + execution policy +
      // wallet + safety contract + tool model + protocols + memory & learning +
      // research + response formatting + mode-core = 10.
      expect(stack.staticLayers.length).toBeGreaterThanOrEqual(10);
      // Turn minimum: runtime clock.
      expect(stack.turnLayers.length).toBeGreaterThanOrEqual(1);
    });

    it("each section is a non-empty string", () => {
      const stack = buildPromptStack(makeContext());
      for (const section of [...stack.staticLayers, ...stack.turnLayers]) {
        expect(typeof section).toBe("string");
        expect(section.length).toBeGreaterThan(0);
      }
    });
  });

  // ── User profile (DB-backed "Vex setup" personalization) ─────
  describe("user profile", () => {
    it("renders the configured display name as address-only style guidance (agent identity stays Vex)", () => {
      const joined = joinedStack(makeContext({ userDisplayName: "Kuba" }));
      expect(joined).toContain("Address the user as Kuba.");
      // The agent's own name is the fixed literal "Vex" — a user display
      // name is address-only style guidance, never a persona rename.
      expect(joined).toContain("You are Vex —");
    });

    it("renders the free-form instructions as a subordinate section when configured", () => {
      const joined = joinedStack(
        makeContext({ userInstructionsMd: "Tone: concise, dry, no emoji." }),
      );
      expect(joined).toContain("## User profile (style preferences)"); // P3 style contract: H2 inside identity
      expect(joined).toContain("Tone: concise, dry, no emoji.");
      // Framed as subordinate to the authoritative rules.
      expect(joined).toContain("does NOT override tool, permission, mission, approval, or safety rules");
    });

    it("renders the work description as style/context guidance", () => {
      const joined = joinedStack(makeContext({ userWorkDescription: "DeFi yield farming" }));
      expect(joined).toContain("The user describes their work as: DeFi yield farming.");
    });

    it("renders the style preset as tone guidance", () => {
      const joined = joinedStack(makeContext({ userStylePreset: "concise" }));
      expect(joined).toContain("- Preferred tone: Concise — short and to the point.");
    });

    it("renders known characteristic traits and silently skips an unrecognized token", () => {
      const joined = joinedStack(
        makeContext({ userCharacteristics: ["warm", "hacker", "emoji"] }),
      );
      expect(joined).toContain("- Style traits: warm and emoji are welcome.");
      expect(joined).not.toContain("hacker");
    });

    it("renders the risk appetite with the verbatim approval-safety boundary phrase", () => {
      const joined = joinedStack(makeContext({ userRiskAppetite: "aggressive" }));
      expect(joined).toContain("the user self-describes a aggressive risk appetite");
      // Test-pinned: this exact phrase must always accompany risk-appetite
      // guidance — it never changes approval/permission/safety behavior.
      expect(joined).toContain("it NEVER changes approval requirements, limits, or safety behavior.");
    });

    it("omits the user profile section when nothing is configured", () => {
      const joined = joinedStack(makeContext());
      expect(joined).not.toContain("## User profile");
    });

    it("omits the user profile section when the new fields are explicitly unset/empty", () => {
      const joined = joinedStack(
        makeContext({ userStylePreset: null, userCharacteristics: [], userRiskAppetite: null }),
      );
      expect(joined).not.toContain("## User profile");
    });

    it("never renders a persona-setup offer (retired 2026-07-20: persona editing is the app UI's job)", () => {
      const joined = joinedStack(makeContext());
      expect(joined).not.toContain("persona.md");
      expect(joined).not.toContain("Internal onboarding behavior");
    });
  });

  // ── Robinhood Chain awareness (Wave 2 batch 2b) ──────────────
  // Every pin below maps to one intentional awareness-only change: the $VEX
  // identity fact, the static Chain awareness section, and the repositioned
  // DexScreener namespace. No execution promises (those land in 2c).
  describe("Robinhood Chain awareness", () => {
    it("identity carries the canonical $VEX fact and drops the stale chain count", () => {
      const joined = joinedStack(makeContext());
      expect(joined).toContain("Your own token $VEX is live on Robinhood Chain");
      expect(joined).toContain("anti-impersonation mechanics, not a warning");
      expect(joined).toContain("major EVM chains, Solana, and Robinhood Chain");
      // Stale "20+ EVM chains and Solana" line is gone.
      expect(joined).not.toContain("20+ EVM chains");
    });

    it("carries the static Chain awareness section for Robinhood Chain (4663)", () => {
      const joined = joinedStack(makeContext());
      expect(joined).toContain("## Chain awareness"); // P3 style contract: H2 inside identity
      expect(joined).toContain("Robinhood Chain (4663): Arbitrum Orbit L2");
      expect(joined).toContain("Not covered by Khalani");
      // Robinhood-launch fix: the awareness line routes balance reads to
      // `wallet_balances`; the old "added to portfolio tracking automatically"
      // promise was false (only spot swaps ever auto-tracked) and is gone.
      expect(joined).toContain("read live balances there with `wallet_balances`");
      expect(joined).not.toContain("added to portfolio tracking automatically");
    });

    it("keeps chain-awareness content in the STATIC prefix (cache-safe, no live numbers)", () => {
      const { staticLayers } = buildPromptStack(makeContext());
      expect(staticLayers.join("\n")).toContain("## Chain awareness");
    });

    it("repositions dexscreener as the market-discovery backbone in the protocols prompt", () => {
      const prompt = buildProtocolsPrompt();
      const dexSection = prompt.split("### dexscreener")[1]?.split("##")[0] ?? "";
      expect(dexSection).toContain("market-discovery backbone");
      expect(dexSection).toContain("discover → resolve address → verify liquidity → quote");
      expect(dexSection).toContain("robinhood");
    });
  });

  // ── Virtuals Protocol integration (Wave 3) ───────────────────
  // Every pin below maps to one intentional Wave-3 change: the static
  // Virtuals trading doctrine (anti-sniper / UNDERGRAD / isVerified rules),
  // the advertised `virtuals` namespace, and the volatile `# $VEX (own token)`
  // banner that must stay OUT of the static prefix (KV-cache invariant).
  describe("Virtuals Protocol (Wave 3)", () => {
    it("protocols prompt advertises the read-only virtuals namespace", () => {
      const prompt = buildProtocolsPrompt();
      expect(prompt).toContain("### virtuals");
      const section = prompt.split("### virtuals")[1]?.split("###")[0] ?? "";
      expect(section).toContain("agent-token intelligence");
      // Read-only namespace: no mutating marker in its section.
      expect(section).not.toContain("Contains mutating tools");
    });

    it("carries the static Virtuals Agent Tokens trading doctrine (imperative, cache-safe)", () => {
      const prompt = buildProtocolsPrompt();
      expect(prompt).toContain("## Virtuals Agent Tokens");
      // Graduated tokens trade via the chain's venue tool quoted in VIRTUAL.
      expect(prompt).toContain("trades on its chain's venue quoted in VIRTUAL");
      expect(prompt).toContain("`tradingRoute` hint");
      // NEVER buy while the anti-sniper window is active.
      expect(prompt).toContain("NEVER buy while `windowActive` is true");
      expect(prompt).toContain("virtuals.get");
      // UNDERGRAD = bonding-curve pre-graduation, extreme caution.
      expect(prompt).toContain("UNDERGRAD means bonding-curve pre-graduation");
      expect(prompt).toContain("extreme caution");
      // isVerified is an anti-impersonation badge, not a quality/safety signal.
      expect(prompt).toContain("anti-impersonation badge, not a quality or safety signal");
    });

    it("Virtuals doctrine renders in the STATIC prefix in every mode", () => {
      const variants: EngineContext[] = [
        makeContext({ sessionKind: "agent", sessionPermission: "restricted" }),
        makeContext({ sessionKind: "agent", sessionPermission: "full" }),
        makeContext({ sessionKind: "mission", sessionPermission: "full", missionId: "m-1", missionRunId: "run-1" }),
      ];
      for (const ctx of variants) {
        const staticJoined = buildPromptStack(ctx).staticLayers.join("\n");
        expect(staticJoined).toContain("## Virtuals Agent Tokens");
      }
    });

    it("carries the static Fixed Yield (Pendle) doctrine (imperative, cache-safe)", () => {
      const prompt = buildProtocolsPrompt();
      expect(prompt).toContain("## Fixed Yield (Pendle)");
      // PT is a term commitment; buying locks a fixed rate until expiry.
      expect(prompt).toContain("TERM COMMITMENT");
      // Early exit is market-priced and can lose.
      expect(prompt).toContain("market-priced");
      // Matured PT redeems ~1:1 via pendle.pt.redeem; value at face.
      expect(prompt).toContain("pendle.pt.redeem");
      // Never present points as yield.
      expect(prompt).toContain("NEVER present points as yield");
      // Preview + gate before trading.
      expect(prompt).toContain("pendle.pt.quote");
    });

    it("Pendle doctrine renders in the STATIC prefix in every mode", () => {
      const variants: EngineContext[] = [
        makeContext({ sessionKind: "agent", sessionPermission: "restricted" }),
        makeContext({ sessionKind: "agent", sessionPermission: "full" }),
        makeContext({ sessionKind: "mission", sessionPermission: "full", missionId: "m-1", missionRunId: "run-1" }),
      ];
      for (const ctx of variants) {
        const staticJoined = buildPromptStack(ctx).staticLayers.join("\n");
        expect(staticJoined).toContain("## Fixed Yield (Pendle)");
      }
    });

    it("ownTokenBanner is TURN-state only: right after the runtime clock, never static", () => {
      const banner = "# $VEX (own token)\n\n- Price: $0.0002918 (24h -54.21%)\n- Market cap: $291,811";
      const stack = buildPromptStack(makeContext(), { ownTokenBanner: banner });
      // Never in the static prefix (live numbers would bust the KV-cache).
      expect(stack.staticLayers.join("\n")).not.toContain("# $VEX (own token)");
      // Turn layer 0 is the runtime clock; the banner is the very next layer.
      expect(stack.turnLayers[0]).toContain("# Runtime Clock");
      expect(stack.turnLayers[1]).toContain("# $VEX (own token)");
    });

    it("banner ordering holds with the full turn-state option set", () => {
      const stack = buildPromptStack(makeContext(), {
        ownTokenBanner: "# $VEX (own token)\n\n- Price: $1",
        contextPressureBanner: "[Context pressure: elevated — 72% used]",
        memorySection: "# Memory\n\n## Memory Routing\n\n- line",
        toolCatalogPrompt: "# Available Tool Map\n\n- wallet_balances",
      });
      const turnJoined = stack.turnLayers.join("\n");
      const order = [
        "# Runtime Clock",
        "# $VEX (own token)",
        "[Context pressure: elevated",
        "# Memory",
        "# Available Tool Map",
      ];
      let lastIdx = -1;
      for (const marker of order) {
        const idx = turnJoined.indexOf(marker);
        expect(idx, `marker missing or out of order: ${marker}`).toBeGreaterThan(lastIdx);
        lastIdx = idx;
      }
    });

    it("empty/absent ownTokenBanner is omitted entirely (fail-soft contract)", () => {
      const withoutOption = buildPromptStack(makeContext());
      expect(withoutOption.turnLayers.join("\n")).not.toContain("$VEX (own token)");
      const withEmpty = buildPromptStack(makeContext(), { ownTokenBanner: "" });
      expect(withEmpty.turnLayers.join("\n")).not.toContain("$VEX (own token)");
    });
  });

  // ── Complete-surface pre-reveal check (Agent Scan plan v3 §11.2) ────────
  //
  // FIX4-W7 / Codex final-review round 3 finding 4 / C42: prior rounds only
  // checked tool NAMES/headings (the tool map, dispatcher classification) or
  // one prompt LAYER (`buildProtocolsPrompt` in isolation, in
  // `protocols.test.ts`). Codex demanded exhaustive coverage: EVERY serialized
  // OpenAI tool description (the real projection the LLM actually receives)
  // AND the COMPLETE built prompt (every static + turn layer, joined, exactly
  // as the engine assembles it) must carry zero pre-reveal mentions of the
  // hidden pair. Nothing is whitelisted except the ONE already-logged,
  // owner-deferred exception below — every other hit is a finding to fix.
  describe("complete-surface pre-reveal check (C42 — no silent whitelist)", () => {
    const HIDDEN_PAIR_NEEDLES = ["uniswap", "swap_quote_uniswap", "swap_execute_uniswap"];

    // Owner-deferred, NOT resolved by this test (see the FIX3-W7 build-log
    // delta in agents_dm/agent-scan-factory.md): Virtuals agent tokens —
    // including $VEX itself, which the identity layer states was "launched
    // via Virtuals Protocol" — genuinely trade via Uniswap V2 on Robinhood
    // Chain (own-token-banner.test.ts pins the "Uniswap V2 vs VIRTUAL" banner
    // text as a real product fact), which sits in tension with the
    // unconditional reveal-gate — a product/architecture question flagged
    // for the coordinator, not a mechanical prompt-wording bug. These are the
    // exact, currently-verified fragments carrying that content — a narrow,
    // logged skip, not a general whitelist. If any of them ever changes, the
    // `.split(...).join("")` below simply stops matching, so the (changed)
    // uniswap mention re-surfaces as a fresh failure requiring conscious
    // re-evaluation rather than silently continuing to exclude evolving
    // text. (`own-token-banner.ts`'s OWN "Uniswap V2 vs VIRTUAL" line is NOT
    // listed here — it only renders via the `ownTokenBanner` PromptStackOptions
    // pass-through, which this test's `buildPromptStack(makeContext())` call
    // never supplies, so it structurally never reaches the built text below.)
    const OWNER_DEFERRED_VIRTUALS_FRAGMENTS = [
      // engine/prompts/identity.ts — $VEX's own listing venue.
      "Your own token $VEX is live on Robinhood Chain, launched via Virtuals Protocol, trading on Uniswap V2 against VIRTUAL. Its unverified badge on Virtuals is normal anti-impersonation mechanics, not a warning.",
      // engine/prompts/protocols.ts's hardcoded "## Virtuals Agent Tokens" doctrine.
      "`uniswap.*` on Robinhood Chain, `kyberswap.*` on Base/Ethereum, `solana.*` on Solana. The `virtuals.get` result's `tradingRoute` hint names the exact venue and the VIRTUAL quote-token address — use it.",
      // tools/protocols/navigation/entries-market.ts's "virtuals" entry, whenToUse.
      "Trades execute via the venue tool named in each result's tradingRoute hint (uniswap on Robinhood, kyberswap on Base/ETH, solana on Solana).",
      // Same entry, preferInstead.
      "Use `dexscreener` for general multi-chain pair/liquidity research and `uniswap`/`kyberswap`/`solana` to execute the trade — Virtuals never executes.",
    ];

    function stripOwnerDeferredVirtualsContent(text: string): string {
      let out = text;
      for (const fragment of OWNER_DEFERRED_VIRTUALS_FRAGMENTS) {
        out = out.split(fragment).join("");
      }
      return out;
    }

    it("the COMPLETE built prompt (every static + turn layer, joined) never mentions the hidden pair pre-reveal", () => {
      resetProtocolsPromptCache();
      const stack = buildPromptStack(makeContext());
      const full = stripOwnerDeferredVirtualsContent(
        [...stack.staticLayers, ...stack.turnLayers].join("\n"),
      );
      const lower = full.toLowerCase();
      for (const needle of HIDDEN_PAIR_NEEDLES) {
        expect(
          lower.includes(needle.toLowerCase()),
          `found "${needle}" in the complete built prompt (outside the logged owner-deferred Virtuals fragments)`,
        ).toBe(false);
      }
    });

    it("EVERY serialized OpenAI tool description (unrevealed posture) never mentions the hidden pair", () => {
      // Default context: no sessionId override => isUniswapPairRevealed(undefined)
      // fails closed to hidden — this IS the unrevealed posture, not a stand-in.
      const tools = getOpenAITools(defaultVisibilityContext());
      const offenders: string[] = [];
      for (const tool of tools) {
        // Serializes the WHOLE tool (name + description + full parameters
        // schema, incl. every property's own description) — not just the
        // top-level description string, so a leak buried in a param
        // description would also be caught. Also structurally proves the
        // hidden tools themselves are absent: if `swap_quote_uniswap` were
        // in this list, its own `function.name` would trip the
        // "swap_quote_uniswap" needle on its own entry.
        const serialized = JSON.stringify(tool).toLowerCase();
        for (const needle of HIDDEN_PAIR_NEEDLES) {
          if (serialized.includes(needle.toLowerCase())) {
            offenders.push(`${tool.function.name}: contains "${needle}"`);
          }
        }
      }
      expect(offenders).toEqual([]);
    });
  });
});
