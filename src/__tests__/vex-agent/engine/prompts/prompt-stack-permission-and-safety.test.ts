import { describe, it, expect, beforeEach } from "vitest";

import type { EngineContext } from "../../../../vex-agent/engine/types.js";
import {
  buildPromptStack,
  buildProtocolsPrompt,
  buildPermissionPrompt,
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
      const prompt = buildPermissionPrompt({ mode: "agent", permission: "restricted" });
      expect(prompt).toContain("approval");
      expect(prompt).toContain("Mutating tools");
    });

    it("agent / full grants full authority", () => {
      const prompt = buildPermissionPrompt({ mode: "agent", permission: "full" });
      expect(prompt).toContain("bypasses only the generic session approval gate");
      expect(prompt).toContain("Per-tool\n  policies always apply");
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
});
