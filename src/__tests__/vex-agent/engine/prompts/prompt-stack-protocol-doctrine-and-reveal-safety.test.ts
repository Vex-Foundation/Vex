import { describe, it, expect, beforeEach } from "vitest";

import type { EngineContext } from "../../../../vex-agent/engine/types.js";
import {
  buildPromptStack,
  buildProtocolsPrompt,
  resetProtocolsPromptCache,
} from "../../../../vex-agent/engine/prompts/index.js";
import { defaultVisibilityContext, getOpenAITools } from "../../../../vex-agent/tools/registry.js";
import { makeContext } from "./_prompt-stack-helpers.js";

describe("prompt-stack — protocol doctrine & reveal safety", () => {
  beforeEach(() => {
    resetProtocolsPromptCache();
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
      // Wave 2 migration rows T449-T451.
      expect(section).toContain("read-only intelligence");
      // Read-only namespace: no mutating marker in its section.
      expect(section).not.toContain("Contains mutating tools");
    });

    it("carries Virtuals acquisition and anti-sniper judgment in the static task shape", () => {
      const prompt = buildProtocolsPrompt();
      // Wave 2 migration rows T452-T459.
      expect(prompt).toContain("### Swap");
      expect(prompt).toContain("Virtuals discovery is read-only");
      expect(prompt).toContain("venue named by its route");
      expect(prompt).toContain("NEVER buy while `windowActive` is true");
      expect(prompt).toContain("virtuals__agent_get");
      expect(prompt).toContain("Bonding-curve pre-graduation can be illiquid");
      expect(prompt).toContain("anti-impersonation, not a quality or safety signal");
    });

    it("Virtuals doctrine renders in the STATIC prefix in every mode", () => {
      const variants: EngineContext[] = [
        makeContext({ sessionKind: "agent", sessionPermission: "restricted" }),
        makeContext({ sessionKind: "agent", sessionPermission: "full" }),
        makeContext({ sessionKind: "mission", sessionPermission: "full", missionId: "m-1", missionRunId: "run-1" }),
      ];
      for (const ctx of variants) {
        const staticJoined = buildPromptStack(ctx).staticLayers.join("\n");
        // Wave 2 migration row T460.
        expect(staticJoined).toContain("NEVER buy while `windowActive` is true");
      }
    });

    it("carries Pendle declaration and yield judgment in the static protocol layer", () => {
      const prompt = buildProtocolsPrompt();
      // Wave 2 migration rows T461-T466.
      expect(prompt).toContain("### pendle");
      expect(prompt).toContain("principal token");
      expect(prompt).toContain("market-priced");
      expect(prompt).toContain("speculative points are not yield");
      expect(prompt).toContain("dry run before broadcast");
      expect(prompt).toContain("Route fixed term yield with a maturity date to Pendle");
    });

    it("Pendle doctrine renders in the STATIC prefix in every mode", () => {
      const variants: EngineContext[] = [
        makeContext({ sessionKind: "agent", sessionPermission: "restricted" }),
        makeContext({ sessionKind: "agent", sessionPermission: "full" }),
        makeContext({ sessionKind: "mission", sessionPermission: "full", missionId: "m-1", missionRunId: "run-1" }),
      ];
      for (const ctx of variants) {
        const staticJoined = buildPromptStack(ctx).staticLayers.join("\n");
        // Wave 2 migration row T467.
        expect(staticJoined).toContain("### pendle");
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
        toolCatalogPrompt: "# Available Tool Map\n\n- WalletBalances",
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
  describe("complete-surface venue check (C42, INVERTED by owner decision D4)", () => {
    const VENUE_NEEDLES = ["SwapQuoteUniswap", "SwapExecuteUniswap"];

    // WHAT THIS BLOCK USED TO ASSERT, and why the opposite is now correct.
    // The Uniswap pair was a HIDDEN, session-revealed fallback, so C42 proved
    // "no silent whitelist": neither the built prompt nor any serialized tool
    // description could mention it before a reveal, because a mention WAS the
    // leak. Owner decision D4 retired the reveal — hiding a venue is what cost
    // the agent its fallback exactly when the primary venue failed, and the
    // approval gate, not visibility, is what protects the money.
    //
    // A retired invariant must not be quietly deleted, or nothing would notice
    // the venue silently disappearing again. So the block is INVERTED: the pair
    // must be PRESENT and callable, and the preference (KyberSwap primary) must
    // be stated in prose rather than enforced by hiding.
    it("the COMPLETE built prompt states the venue preference in prose", () => {
      resetProtocolsPromptCache();
      const stack = buildPromptStack(makeContext());
      const full = [...stack.staticLayers, ...stack.turnLayers].join("\n");

      // Wave 2 migration rows T473 and T474.
      expect(full).toContain("KyberSwap is the primary EVM swap venue");
      expect(full.match(/KyberSwap is the primary EVM swap venue/g)).toHaveLength(1);
      // The preference is guidance, never a gate: the prompt must not claim the
      // alternative is locked, unavailable, or has to be unlocked by a failure.
      expect(full).not.toMatch(/unlocks? it|now available for this session|backup venue is now available/i);
    });

    it("EVERY venue tool is present in the serialized OpenAI tool surface", () => {
      // Default context: no sessionId. Under the old reveal this was the
      // "unrevealed posture" and the pair was absent; there is no such posture
      // any more, and a session that never touched KyberSwap must still be able
      // to reach Uniswap.
      const tools = getOpenAITools(defaultVisibilityContext());
      const names = tools.map((t) => t.function.name);
      for (const needle of VENUE_NEEDLES) {
        expect(names, `${needle} is missing from the default tool surface`).toContain(needle);
      }
      expect(names).toContain("BridgeQuoteRelay");
      expect(names).toContain("BridgeExecuteRelay");
    });
  });
});
