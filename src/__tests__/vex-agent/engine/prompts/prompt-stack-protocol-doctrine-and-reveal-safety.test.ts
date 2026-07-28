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
      expect(section).toContain("agent-token intelligence");
      // Read-only namespace: no mutating marker in its section.
      expect(section).not.toContain("Contains mutating tools");
    });

    it("carries the static Virtuals Agent Tokens trading doctrine (imperative, cache-safe)", () => {
      const prompt = buildProtocolsPrompt();
      expect(prompt).toContain("## Virtuals Agent Tokens");
      // Graduated tokens trade via the chain's venue tool quoted in VIRTUAL.
      expect(prompt).toContain("trades against VIRTUAL on its chain's venue");
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
    // 2026-07-28 (prompt-unambiguity W1/A1): three of the four fragments were
    // REMOVED rather than deferred — the `## Virtuals Agent Tokens` doctrine and
    // the `virtuals` navigation entry now use the reveal-compatible
    // `swap_quote`/`swap_execute` wording instead of naming the hidden venue.
    // Only $VEX's own listing fact remains deferred (it is a product fact about
    // the agent's own token, not routing doctrine).
    const OWNER_DEFERRED_VIRTUALS_FRAGMENTS = [
      // engine/prompts/identity.ts — $VEX's own listing venue.
      "Your own token $VEX is live on Robinhood Chain, launched via Virtuals Protocol, trading on Uniswap V2 against VIRTUAL. Its unverified badge on Virtuals is normal anti-impersonation mechanics, not a warning.",
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
