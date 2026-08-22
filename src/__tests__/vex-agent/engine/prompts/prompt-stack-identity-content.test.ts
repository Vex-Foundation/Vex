import { describe, it, expect, beforeEach } from "vitest";

import {
  buildPromptStack,
  buildProtocolsPrompt,
  resetProtocolsPromptCache,
} from "../../../../vex-agent/engine/prompts/index.js";
import { makeContext, joinedStack } from "./_prompt-stack-helpers.js";

describe("prompt-stack — identity content", () => {
  beforeEach(() => {
    resetProtocolsPromptCache();
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
      // `WalletBalances`; the old "added to portfolio tracking automatically"
      // promise was false (only spot swaps ever auto-tracked) and is gone.
      expect(joined).toContain("read live balances there with `WalletBalances`");
      expect(joined).not.toContain("added to portfolio tracking automatically");
    });

    it("keeps chain-awareness content in the STATIC prefix (cache-safe, no live numbers)", () => {
      const { staticLayers } = buildPromptStack(makeContext());
      expect(staticLayers.join("\n")).toContain("## Chain awareness");
    });

    it("repositions dexscreener as the market-discovery backbone in the protocols prompt", () => {
      const prompt = buildProtocolsPrompt();
      const dexSection = prompt.split("### dexscreener\n")[1]?.split("\n### ")[0] ?? "";
      // Wave 2 migration rows T319-T321.
      expect(dexSection).toContain("read-only market research");
      expect(dexSection).toContain("exact chain and contract address");
      expect(dexSection).toContain("provider's index");
    });
  });
});
