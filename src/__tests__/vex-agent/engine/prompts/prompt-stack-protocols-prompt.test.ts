import { describe, it, expect, beforeEach, afterEach } from "vitest";

import {
  buildPromptStack,
  buildProtocolsPrompt,
  resetProtocolsPromptCache,
} from "../../../../vex-agent/engine/prompts/index.js";
import { protocolAvailabilityFingerprint } from "../../../../vex-agent/engine/prompts/protocols.js";
import {
  PROTOCOL_ADVERTISED_NAMESPACE_ALLOWLIST,
  PROTOCOL_NAMESPACE_ALLOWLIST,
  PROTOCOL_TOOLS,
  isProtocolToolAvailable,
} from "../../../../vex-agent/tools/protocols/catalog.js";
import { makeContext, joinedStack } from "./_prompt-stack-helpers.js";

describe("prompt-stack — protocols prompt", () => {
  beforeEach(() => {
    resetProtocolsPromptCache();
  });

  // ── Protocols generated from catalog ────────────────────────

  describe("protocols prompt", () => {
    it("mentions the AVAILABLE action count from the actual catalog", () => {
      const prompt = buildProtocolsPrompt();
      const availableToolCount = PROTOCOL_TOOLS.filter((tool) =>
        PROTOCOL_ADVERTISED_NAMESPACE_ALLOWLIST.includes(tool.namespace),
      ).filter(isProtocolToolAvailable).length;
      expect(prompt).toContain(`Total: ${availableToolCount} protocol actions`);
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

    it("gives each namespace its prefix, an action count, and example toolIds (scent, not a menu)", () => {
      const prompt = buildProtocolsPrompt();

      expect(prompt).toContain("`dexscreener.*`");
      expect(prompt).toMatch(/· \d+ actions/);
      expect(prompt).toContain("Examples: dexscreener.");
      // The full per-action documentation lives behind discovery, not here.
      expect(prompt).not.toContain("Paths:");
      expect(prompt).not.toContain("Requires env:");
    });

    it("never advertises a non-advertised namespace (reveal safety)", () => {
      const prompt = buildProtocolsPrompt().toLowerCase();
      const hidden = PROTOCOL_NAMESPACE_ALLOWLIST.filter(
        (ns) => !(PROTOCOL_ADVERTISED_NAMESPACE_ALLOWLIST as readonly string[]).includes(ns),
      );
      expect(hidden.length).toBeGreaterThan(0);
      for (const ns of hidden) {
        expect(prompt, `non-advertised namespace "${ns}" leaked into the protocols prompt`)
          .not.toContain(ns.toLowerCase());
      }
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
        const nsSection = prompt.split(`### ${ns}`)[1]?.split("##")[0] ?? "";
        // Env-gated namespaces can legitimately have zero AVAILABLE actions in
        // this install; the marker describes what is callable, not the catalog.
        if (nsSection.includes("· 0 actions")) continue;
        expect(nsSection).toContain("mutating");
      }
    });

    it("is not hardcoded — count changes with catalog", () => {
      const prompt = buildProtocolsPrompt();
      const availableToolCount = PROTOCOL_TOOLS.filter((tool) =>
        (PROTOCOL_ADVERTISED_NAMESPACE_ALLOWLIST as readonly string[]).includes(tool.namespace),
      ).filter(isProtocolToolAvailable).length;
      expect(prompt).toContain(String(availableToolCount));
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

    // SUPERSEDED CONTRACT (2026-07-28): the static layer used to hide live
    // availability for KV-cache stability, which meant it advertised actions a
    // key-less install cannot call. `process.env` is not process-stable anyway
    // (the secret vault sets/deletes keys on unlock/lock), so the layer is now
    // availability-aware and its cache is keyed by a non-secret fingerprint of
    // the PRESENT `requiresEnv` names. A mid-session key change rebuilds it
    // once — the accepted cost of telling the model the truth.
    it("counts only AVAILABLE actions and preserves the namespace at zero", () => {
      delete process.env.JUPITER_API_KEY;
      const prompt = buildProtocolsPrompt();
      const solanaSection = prompt.split("### solana")[1]?.split("###")[0] ?? "";
      expect(solanaSection).toContain("· 0 actions");
      expect(solanaSection).toContain("a required API key is not configured");
      // PRESERVED, never deleted: its absence would read as "this capability
      // does not exist" rather than "a key is missing".
      expect(prompt).toContain("### solana");
    });

    it("rebuilds across absent → present → absent env transitions (no stale cache)", () => {
      delete process.env.JUPITER_API_KEY;
      const absent = buildProtocolsPrompt();
      expect(protocolAvailabilityFingerprint()).not.toContain("JUPITER_API_KEY");
      expect(absent.split("### solana")[1]?.split("###")[0] ?? "").toContain("· 0 actions");

      // No resetProtocolsPromptCache() anywhere below: the cache must notice
      // the env change on its own, exactly as it does when the vault unlocks
      // mid-session.
      process.env.JUPITER_API_KEY = "test-jupiter-key";
      const present = buildProtocolsPrompt();
      expect(protocolAvailabilityFingerprint()).toContain("JUPITER_API_KEY");
      expect(present).not.toBe(absent);
      const presentSolana = present.split("### solana")[1]?.split("###")[0] ?? "";
      expect(presentSolana).not.toContain("· 0 actions");
      expect(presentSolana).toContain("Examples: solana.");

      delete process.env.JUPITER_API_KEY;
      const absentAgain = buildProtocolsPrompt();
      expect(absentAgain).toBe(absent);
    });

    it("the fingerprint carries env NAMES only, never values", () => {
      process.env.JUPITER_API_KEY = "sk-super-secret-value";
      const fingerprint = protocolAvailabilityFingerprint();
      expect(fingerprint).toContain("JUPITER_API_KEY");
      expect(fingerprint).not.toContain("sk-super-secret-value");
      expect(buildProtocolsPrompt()).not.toContain("sk-super-secret-value");
    });
  });
});
