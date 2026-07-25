import { describe, it, expect, beforeEach, afterEach } from "vitest";

import {
  buildPromptStack,
  buildProtocolsPrompt,
  resetProtocolsPromptCache,
} from "../../../../vex-agent/engine/prompts/index.js";
import { PROTOCOL_ADVERTISED_NAMESPACE_ALLOWLIST, PROTOCOL_TOOLS } from "../../../../vex-agent/tools/protocols/catalog.js";
import { makeContext, joinedStack } from "./_prompt-stack-helpers.js";

describe("prompt-stack — protocols prompt", () => {
  beforeEach(() => {
    resetProtocolsPromptCache();
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
});
