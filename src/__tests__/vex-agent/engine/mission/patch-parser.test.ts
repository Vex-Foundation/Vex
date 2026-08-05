import { describe, it, expect } from "vitest";

import { extractMissionPatch, sanitizePatch } from "../../../../vex-agent/engine/mission/patch-parser.js";

describe("patch-parser", () => {
  // ── extractMissionPatch ─────────────────────────────────────

  describe("extractMissionPatch", () => {
    it("returns null for null input", () => {
      expect(extractMissionPatch(null)).toBeNull();
    });

    it("returns null for undefined input", () => {
      expect(extractMissionPatch(undefined)).toBeNull();
    });

    it("returns null for non-object", () => {
      expect(extractMissionPatch("string")).toBeNull();
      expect(extractMissionPatch(42)).toBeNull();
      expect(extractMissionPatch(true)).toBeNull();
    });

    it("returns null for array", () => {
      expect(extractMissionPatch([1, 2, 3])).toBeNull();
    });

    it("returns null for object with no valid keys", () => {
      expect(extractMissionPatch({ foo: "bar", baz: 42 })).toBeNull();
    });

    it("extracts valid string fields", () => {
      const patch = extractMissionPatch({ title: "SOL DCA", goal: "Accumulate SOL" });
      expect(patch).not.toBeNull();
      expect(patch!.title).toBe("SOL DCA");
      expect(patch!.goal).toBe("Accumulate SOL");
    });

    it("extracts a numeric durationMinutes field", () => {
      const patch = extractMissionPatch({ durationMinutes: 5 });
      expect(patch!.durationMinutes).toBe(5);
    });

    it("extracts valid array fields", () => {
      const patch = extractMissionPatch({ allowedChains: ["solana"], successCriteria: ["10 SOL"] });
      expect(patch!.allowedChains).toEqual(["solana"]);
      expect(patch!.successCriteria).toEqual(["10 SOL"]);
    });

    it("strips unknown keys", () => {
      const patch = extractMissionPatch({ title: "Test", malicious: "DROP TABLE" });
      expect(patch!.title).toBe("Test");
      expect((patch as Record<string, unknown>).malicious).toBeUndefined();
    });

    it("strips undefined values", () => {
      const patch = extractMissionPatch({ title: "Test", goal: undefined });
      expect(patch!.title).toBe("Test");
      expect(patch!.goal).toBeUndefined();
    });
  });

  // ── sanitizePatch ───────────────────────────────────────────

  describe("sanitizePatch", () => {
    it("trims strings", () => {
      const result = sanitizePatch({ title: "  SOL DCA  ", goal: "  test  " });
      expect(result.title).toBe("SOL DCA");
      expect(result.goal).toBe("test");
    });

    it("converts empty strings to null", () => {
      const result = sanitizePatch({ title: "", goal: "   " });
      expect(result.title).toBeNull();
      expect(result.goal).toBeNull();
    });

    it("truncates long strings", () => {
      const longStr = "x".repeat(3000);
      const result = sanitizePatch({ title: longStr });
      expect(result.title!.length).toBe(2000);
    });

    it("passes null through for strings", () => {
      const result = sanitizePatch({ title: null });
      expect(result.title).toBeNull();
    });

    it("rejects non-string values for string fields", () => {
      const result = sanitizePatch({ title: 42, goal: true, riskProfile: [1, 2] });
      expect(result.title).toBeUndefined();
      expect(result.goal).toBeUndefined();
      expect(result.riskProfile).toBeUndefined();
    });

    // ── durationMinutes (numeric, NOT string) ──────────────────

    it("keeps a numeric durationMinutes — regression: it must not be dropped as a string field", () => {
      const result = sanitizePatch({ durationMinutes: 5 });
      expect(result.durationMinutes).toBe(5);
    });

    it("truncates a fractional durationMinutes to a whole minute", () => {
      const result = sanitizePatch({ durationMinutes: 5.9 });
      expect(result.durationMinutes).toBe(5);
    });

    it("clamps durationMinutes to the 24h ceiling", () => {
      const result = sanitizePatch({ durationMinutes: 99999 });
      expect(result.durationMinutes).toBe(1440);
    });

    it("rejects a non-positive durationMinutes", () => {
      expect(sanitizePatch({ durationMinutes: 0 }).durationMinutes).toBeUndefined();
      expect(sanitizePatch({ durationMinutes: -5 }).durationMinutes).toBeUndefined();
      expect(sanitizePatch({ durationMinutes: 0.5 }).durationMinutes).toBeUndefined();
    });

    it("passes null through for durationMinutes", () => {
      const result = sanitizePatch({ durationMinutes: null });
      expect(result.durationMinutes).toBeNull();
    });

    it("rejects a numeric-string durationMinutes (model must send a JSON number)", () => {
      const result = sanitizePatch({ durationMinutes: "60" });
      expect(result.durationMinutes).toBeUndefined();
    });

    it("sanitizes string arrays", () => {
      const result = sanitizePatch({ allowedChains: ["  solana  ", "ethereum"] });
      expect(result.allowedChains).toEqual(["solana", "ethereum"]);
    });

    it("filters empty strings from arrays", () => {
      const result = sanitizePatch({ allowedChains: ["solana", "", "  "] });
      expect(result.allowedChains).toEqual(["solana"]);
    });

    it("filters non-string items from arrays", () => {
      const result = sanitizePatch({ allowedChains: ["solana", 42, true, "ethereum"] });
      expect(result.allowedChains).toEqual(["solana", "ethereum"]);
    });

    it("passes null through for arrays", () => {
      const result = sanitizePatch({ allowedChains: null });
      expect(result.allowedChains).toBeNull();
    });

    it("converts empty array to null", () => {
      const result = sanitizePatch({ allowedChains: [] });
      expect(result.allowedChains).toBeNull();
    });

    it("converts array of only empty strings to null", () => {
      const result = sanitizePatch({ allowedChains: ["", "  "] });
      expect(result.allowedChains).toBeNull();
    });

    it("rejects non-array values for array fields", () => {
      const result = sanitizePatch({ allowedChains: "solana" });
      expect(result.allowedChains).toBeUndefined();
    });

    it("limits array items", () => {
      const longArray = Array.from({ length: 100 }, (_, i) => `item-${i}`);
      const result = sanitizePatch({ allowedChains: longArray });
      expect(result.allowedChains!.length).toBe(50);
    });

    it("truncates individual array items", () => {
      const longItem = "x".repeat(1000);
      const result = sanitizePatch({ allowedChains: [longItem] });
      expect(result.allowedChains![0].length).toBe(500);
    });

    it("handles complete valid patch", () => {
      const result = sanitizePatch({
        title: "SOL DCA Strategy",
        goal: "Accumulate 10 SOL",
        capitalSource: "wallet",
        startingCapital: "500 USDC",
        riskProfile: "conservative",
        allowedWallets: ["solana"],
        allowedChains: ["solana"],
        allowedProtocols: ["solana"],
        successCriteria: ["Accumulated 10 SOL"],
        stopConditions: ["capital_depleted", "deadline_reached"],
        deadline: "2026-04-04",
        durationMinutes: 60,
      });

      expect(result.title).toBe("SOL DCA Strategy");
      expect(result.goal).toBe("Accumulate 10 SOL");
      expect(result.capitalSource).toBe("wallet");
      expect(result.startingCapital).toBe("500 USDC");
      expect(result.riskProfile).toBe("conservative");
      expect(result.allowedWallets).toEqual(["solana"]);
      expect(result.allowedChains).toEqual(["solana"]);
      expect(result.allowedProtocols).toEqual(["solana"]);
      expect(result.successCriteria).toEqual(["Accumulated 10 SOL"]);
      expect(result.stopConditions).toEqual(["capital_depleted", "deadline_reached"]);
      expect(result.deadline).toBe("2026-04-04");
      expect(result.durationMinutes).toBe(60);
    });

    it("drops stopConditionsAccepted from model output", () => {
      // The model surface no longer exposes `stopConditionsAccepted`.
      // Even if the model emits the key in its JSON output (prose or
      // tool args), the parser must drop it at the boundary. Acceptance
      // is host-only via `mission.acceptContract` IPC → mig 023.
      const extracted = extractMissionPatch({
        title: "SOL DCA",
        stopConditions: ["capital_depleted"],
        stopConditionsAccepted: true,
      });
      expect(extracted).not.toBeNull();
      expect("stopConditionsAccepted" in (extracted ?? {})).toBe(false);

      const sanitized = sanitizePatch({
        title: "SOL DCA",
        stopConditions: ["capital_depleted"],
        // Field no longer exists on `MissionDraft`. `MissionPatch` carries an
        // index signature (raw model prose), so the compiler cannot reject it —
        // the DROP is the runtime guarantee asserted below.
        stopConditionsAccepted: true,
      });
      expect("stopConditionsAccepted" in sanitized).toBe(false);
    });
  });

  // ── Full pipeline ───────────────────────────────────────────

  describe("extract → sanitize pipeline", () => {
    it("handles malicious input end-to-end", () => {
      const raw = {
        title: "  Valid Title  ",
        __proto__: "attack",
        constructor: "attack",
        allowedChains: ["solana", 42, "", null],
        unknownField: "DROP TABLE missions",
      };

      const patch = extractMissionPatch(raw);
      expect(patch).not.toBeNull();

      const sanitized = sanitizePatch(patch!);
      expect(sanitized.title).toBe("Valid Title");
      expect(sanitized.allowedChains).toEqual(["solana"]);
      expect((sanitized as Record<string, unknown>).unknownField).toBeUndefined();
    });

    it("returns empty for completely invalid input", () => {
      const patch = extractMissionPatch({ invalid: true, bad: "data" });
      expect(patch).toBeNull();
    });
  });
});
