import { describe, it, expect, beforeEach } from "vitest";

import type { Permission, SessionKind } from "../../../../vex-agent/engine/types.js";
import {
  buildPromptStack,
  resetProtocolsPromptCache,
} from "../../../../vex-agent/engine/prompts/index.js";
import type { PromptStackOptions } from "../../../../vex-agent/engine/prompts/index.js";
import { makeContext, joinedStack } from "./_prompt-stack-helpers.js";

describe("prompt-stack — layer composition", () => {
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
});
