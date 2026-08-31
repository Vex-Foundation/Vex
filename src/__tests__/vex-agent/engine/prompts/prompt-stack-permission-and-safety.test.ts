import { describe, it, expect, beforeEach } from "vitest";

import type { EngineContext } from "../../../../vex-agent/engine/types.js";
import {
  buildPromptStack,
  buildProtocolsPrompt,
  buildPermissionPrompt,
  resolveExecutionPhase,
  resetProtocolsPromptCache,
} from "../../../../vex-agent/engine/prompts/index.js";
import { makeContext, joinedStack } from "./_prompt-stack-helpers.js";

describe("prompt-stack — permission & safety", () => {
  beforeEach(() => {
    resetProtocolsPromptCache();
  });

  // ── Permission prompts ──────────────────────────────────────

  describe("permission prompts", () => {
    it("agent / restricted requires approval for mutations", () => {
      const prompt = buildPermissionPrompt({ phase: "agent", permission: "restricted" });
      expect(prompt).toContain("approval");
      expect(prompt).toContain("Mutating tools");
    });

    it("agent / full grants full authority", () => {
      const prompt = buildPermissionPrompt({ phase: "agent", permission: "full" });
      expect(prompt).toContain("bypasses only the generic session approval gate");
      expect(prompt).toContain("Per-tool\n  policies always apply");
    });

    it("mission RUN / restricted requires approval and supports LoopDefer", () => {
      const prompt = buildPermissionPrompt({ phase: "mission_run", permission: "restricted" });
      expect(prompt).toContain("approval");
      expect(prompt).toContain("LoopDefer");
    });

    it("mission RUN / full grants full authority", () => {
      const prompt = buildPermissionPrompt({ phase: "mission_run", permission: "full" });
      expect(prompt).toContain("bypasses only the generic session approval gate");
      expect(prompt).toContain("Per-tool\n  policies always apply");
    });

    // Mission SETUP used to receive the mission RUN policy ("take proactive
    // actions", `LoopDefer`), contradicting the setup execution lock shown
    // three layers later. The phase input, derived from missionRunId, splits
    // them.
    it("mission SETUP carries the execution lock and the draft-first job, never the run loop", () => {
      for (const permission of ["restricted", "full"] as const) {
        const prompt = buildPermissionPrompt({ phase: "mission_setup", permission });
        expect(prompt).toContain("MISSION SETUP");
        expect(prompt).toContain("MissionDraftUpdate");
        expect(prompt).toContain("LOCKED during");
        expect(prompt).not.toContain("LoopDefer");
        expect(prompt).not.toContain("proactive");
      }
    });

    it("resolveExecutionPhase derives the phase from sessionKind + missionRunId", () => {
      expect(resolveExecutionPhase({ sessionKind: "agent", missionRunId: null })).toBe("agent");
      expect(resolveExecutionPhase({ sessionKind: "agent", missionRunId: "run-1" })).toBe("agent");
      expect(resolveExecutionPhase({ sessionKind: "mission", missionRunId: null })).toBe("mission_setup");
      expect(resolveExecutionPhase({ sessionKind: "mission", missionRunId: undefined })).toBe("mission_setup");
      expect(resolveExecutionPhase({ sessionKind: "mission", missionRunId: "run-1" })).toBe("mission_run");
    });

    it("the stack selects the setup policy for a mission session with no active run", () => {
      const setup = buildPromptStack(makeContext({ sessionKind: "mission", sessionPermission: "restricted" }))
        .staticLayers.join("\n");
      expect(setup).toContain("# Execution Policy: MISSION SETUP / RESTRICTED");
      expect(setup).not.toContain("# Execution Policy: MISSION RUN");

      const run = buildPromptStack(makeContext({
        sessionKind: "mission", sessionPermission: "restricted", missionId: "m-1", missionRunId: "run-1",
      })).staticLayers.join("\n");
      expect(run).toContain("# Execution Policy: MISSION RUN / RESTRICTED");
      expect(run).not.toContain("MISSION SETUP");
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
      expect(joined).toContain('TokenFind(query="SYMBOL", chainIds="TARGET_CHAIN")');
      expect(joined).toContain("mutation-ready");
      expect(joined).not.toContain("khalani__tokens_search");
    });

    it("the swap task resolves token identity before venue execution", () => {
      const prompt = buildProtocolsPrompt();
      // Wave 2 migration rows T433 and T434.
      const swapSection = prompt.split("### Swap\n")[1]?.split("\n### ")[0] ?? "";
      expect(swapSection).toContain("Resolve the exact token and chain");
      expect(swapSection).not.toContain("kyberswap.tokens.search");
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
      const agentFull = buildPermissionPrompt({ phase: "agent", permission: "full" });
      const missionFull = buildPermissionPrompt({ phase: "mission_run", permission: "full" });
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
});
