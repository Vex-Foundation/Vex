import { describe, it, expect } from "vitest";

import {
  CONTRACT_HASH_VERSION,
  LEGACY_CONTRACT_HASH_VERSION,
  LEGACY_V2_CONTRACT_HASH_VERSION,
  buildContractMaterial,
  canonicalStringify,
  computeContractHash,
} from "../../../../vex-agent/engine/mission/contract-hash.js";
import type { MissionDraft } from "../../../../vex-agent/engine/types.js";

function makeDraft(overrides: Partial<MissionDraft> = {}): MissionDraft {
  return {
    title: "SOL DCA",
    goal: "Accumulate 10 SOL",
    capitalSource: "wallet",
    startingCapital: "500 USDC",
    allowedWallets: ["solana"],
    allowedChains: ["solana"],
    allowedProtocols: ["jupiter"],
    riskProfile: "conservative",
    successCriteria: ["Accumulated 10 SOL"],
    stopConditions: ["capital_depleted", "deadline_reached"],
    deadline: "2026-04-04",
    durationMinutes: null,
    ...overrides,
  };
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

describe("contract-hash", () => {
  // ── computeContractHash ─────────────────────────────────────────

  describe("computeContractHash", () => {
    it("pins legacy v1 material and hash byte-for-byte", () => {
      const draft = makeDraft();
      expect(buildContractMaterial(draft, LEGACY_CONTRACT_HASH_VERSION)).toEqual({
        v: 1,
        goal: "Accumulate 10 SOL",
        capitalSource: "wallet",
        startingCapital: "500 USDC",
        riskProfile: "conservative",
        deadline: "2026-04-04",
        allowedWallets: ["solana"],
        allowedChains: ["solana"],
        allowedProtocols: ["jupiter"],
        successCriteria: ["Accumulated 10 SOL"],
        stopConditions: ["capital_depleted", "deadline_reached"],
      });
      expect(computeContractHash(draft, LEGACY_CONTRACT_HASH_VERSION)).toBe("5ab63e3ae4613916e47e2bc7f587304c9e7efa7441b4879793faafd2eac24244");
    });

    // ── Frozen v2 (Agent Scan Phase 3 — Hyperliquid removal) ──────
    //
    // v2 is a FROZEN historical shape: MissionDraft no longer carries
    // `hyperliquidRisk` (removed from the live agent), so the risk material
    // is passed as a separate raw `legacyHyperliquidRisk` argument, sourced
    // in production from `mapper.extractLegacyHyperliquidRiskV2`. These
    // golden hashes were captured from the PRE-removal implementation
    // (draft.hyperliquidRisk + CanonicalContractMaterialV2Schema) so they
    // prove a mission accepted under the old v2 shape still reproduces its
    // exact original `accepted_contract_hash` byte-for-byte.
    it("reproduces a stored v2 hash byte-for-byte via the frozen legacy material (backward-compat proof)", () => {
      const risk = { leverageCap: 3, perOrderNotionalPct: 20, totalNotionalPct: 100, marketAllowlist: ["eth", "BTC", "ETH"] };
      const material = buildContractMaterial(makeDraft(), LEGACY_V2_CONTRACT_HASH_VERSION, risk);
      expect(material.v).toBe(2);
      expect("hyperliquidRisk" in material && material.hyperliquidRisk).toEqual({ ...risk, marketAllowlist: ["BTC", "ETH"] });
      expect(computeContractHash(makeDraft(), LEGACY_V2_CONTRACT_HASH_VERSION, risk)).toBe(
        "0fa117eca4bbed8d2d4bff9ea68381b80e6b71bab1da307fe47235385935722e",
      );
      expect(computeContractHash(makeDraft(), LEGACY_V2_CONTRACT_HASH_VERSION, null)).toBe(
        "f0462053bcc83f3bfe0bb127016b1dad92265aab2a5677261de01b9ddf641a22",
      );
    });

    it("drops invalid legacy v2 risk material to null instead of throwing", () => {
      const material = buildContractMaterial(makeDraft(), LEGACY_V2_CONTRACT_HASH_VERSION, { leverageCap: "not-a-number" });
      expect("hyperliquidRisk" in material && material.hyperliquidRisk).toBeNull();
    });

    it("v1 and v3 material ignore a legacyHyperliquidRisk argument entirely", () => {
      const risk = { leverageCap: 3, perOrderNotionalPct: 20, totalNotionalPct: 100 };
      const v1WithRisk = buildContractMaterial(makeDraft(), LEGACY_CONTRACT_HASH_VERSION, risk);
      const v1Without = buildContractMaterial(makeDraft(), LEGACY_CONTRACT_HASH_VERSION);
      expect(v1WithRisk).toEqual(v1Without);
      expect("hyperliquidRisk" in v1WithRisk).toBe(false);

      const v3WithRisk = buildContractMaterial(makeDraft(), CONTRACT_HASH_VERSION, risk);
      const v3Without = buildContractMaterial(makeDraft(), CONTRACT_HASH_VERSION);
      expect(v3WithRisk).toEqual(v3Without);
      expect("hyperliquidRisk" in v3WithRisk).toBe(false);
    });

    it("returns 64-char lowercase hex (sha256)", () => {
      const hash = computeContractHash(makeDraft());
      expect(hash).toMatch(SHA256_HEX);
    });

    it("is deterministic for the same draft", () => {
      const a = computeContractHash(makeDraft());
      const b = computeContractHash(makeDraft());
      expect(a).toBe(b);
    });

    it("ignores `title` — it's display-only, not runtime-affecting", () => {
      const a = computeContractHash(makeDraft({ title: "First" }));
      const b = computeContractHash(makeDraft({ title: "Second" }));
      expect(a).toBe(b);
    });

    it("collapses null / undefined / empty / whitespace to the same canonical value", () => {
      const fromNull = computeContractHash(makeDraft({ riskProfile: null }));
      const fromEmpty = computeContractHash(makeDraft({ riskProfile: "" }));
      const fromWhitespace = computeContractHash(makeDraft({ riskProfile: "   " }));
      expect(fromNull).toBe(fromEmpty);
      expect(fromEmpty).toBe(fromWhitespace);
    });

    it("trims whitespace in fields without changing the hash", () => {
      const trimmed = computeContractHash(makeDraft({ goal: "Accumulate 10 SOL" }));
      const padded = computeContractHash(makeDraft({ goal: "  Accumulate 10 SOL  " }));
      expect(trimmed).toBe(padded);
    });

    it("reorders allowedChains without changing the hash (set semantics)", () => {
      const a = computeContractHash(makeDraft({ allowedChains: ["solana", "ethereum"] }));
      const b = computeContractHash(makeDraft({ allowedChains: ["ethereum", "solana"] }));
      expect(a).toBe(b);
    });

    it("lowercases chain ids (case-insensitive)", () => {
      const lower = computeContractHash(makeDraft({ allowedChains: ["solana"] }));
      const upper = computeContractHash(makeDraft({ allowedChains: ["SOLANA"] }));
      expect(lower).toBe(upper);
    });

    it("reorders allowedWallets without changing the hash", () => {
      const a = computeContractHash(makeDraft({ allowedWallets: ["a", "b"] }));
      const b = computeContractHash(makeDraft({ allowedWallets: ["b", "a"] }));
      expect(a).toBe(b);
    });

    it("preserves order for stopConditions (sequential rules)", () => {
      // Reordering stopConditions IS a meaningful change — these are
      // sequential terminal permissions and the user committed to
      // them in a specific order. Hash MUST differ.
      const a = computeContractHash(makeDraft({
        stopConditions: ["capital_depleted", "deadline_reached"],
      }));
      const b = computeContractHash(makeDraft({
        stopConditions: ["deadline_reached", "capital_depleted"],
      }));
      expect(a).not.toBe(b);
    });

    it("preserves order for successCriteria (sequential commitments)", () => {
      const a = computeContractHash(makeDraft({
        successCriteria: ["first", "second"],
      }));
      const b = computeContractHash(makeDraft({
        successCriteria: ["second", "first"],
      }));
      expect(a).not.toBe(b);
    });

    it("treats different startingCapital strings as different (no float coercion)", () => {
      // "1.0" vs "1.00" carry different user precision intent and must
      // not be folded together. The normalizer is string-only — even
      // if a number sneaks past TypeScript via `as`, it'd be rejected
      // by the schema parse. Here we just assert the string-level
      // distinction.
      const a = computeContractHash(makeDraft({ startingCapital: "1.0" }));
      const b = computeContractHash(makeDraft({ startingCapital: "1.00" }));
      expect(a).not.toBe(b);
    });

    it("changes hash when goal changes", () => {
      const a = computeContractHash(makeDraft({ goal: "Accumulate 10 SOL" }));
      const b = computeContractHash(makeDraft({ goal: "Accumulate 20 SOL" }));
      expect(a).not.toBe(b);
    });
  });

  // ── canonicalStringify ──────────────────────────────────────────

  describe("canonicalStringify", () => {
    it("sorts object keys recursively", () => {
      const a = canonicalStringify({ b: 1, a: 2 });
      const b = canonicalStringify({ a: 2, b: 1 });
      expect(a).toBe(b);
      expect(a).toBe('{"a":2,"b":1}');
    });

    it("sorts nested object keys too", () => {
      const a = canonicalStringify({ outer: { z: 1, a: 2 } });
      const b = canonicalStringify({ outer: { a: 2, z: 1 } });
      expect(a).toBe(b);
    });

    it("preserves array order", () => {
      const a = canonicalStringify([3, 1, 2]);
      const b = canonicalStringify([1, 2, 3]);
      expect(a).not.toBe(b);
    });

    it("handles null and undefined as the canonical 'null' token", () => {
      expect(canonicalStringify(null)).toBe("null");
      expect(canonicalStringify(undefined)).toBe("null");
    });

    it("escapes strings via JSON.stringify (quotes, control chars)", () => {
      expect(canonicalStringify("a\"b")).toBe('"a\\"b"');
    });
  });

  // ── buildContractMaterial ───────────────────────────────────────

  describe("buildContractMaterial", () => {
    it("includes the version literal", () => {
      const material = buildContractMaterial(makeDraft());
      expect(material.v).toBe(CONTRACT_HASH_VERSION);
    });

    it("strips title from the material (not in the schema)", () => {
      const material = buildContractMaterial(makeDraft({ title: "ignored" }));
      // strict() Zod schema rejects unknown keys, so `title` would have
      // failed the parse if it leaked in. The test pins the absence.
      expect("title" in material).toBe(false);
    });

    it("normalizes allowedChains to lowercase + sorted", () => {
      const material = buildContractMaterial(makeDraft({
        allowedChains: ["SOLANA", "ethereum", "arbitrum"],
      }));
      expect(material.allowedChains).toEqual(["arbitrum", "ethereum", "solana"]);
    });

    it("preserves stopConditions order (sequential semantics)", () => {
      const material = buildContractMaterial(makeDraft({
        stopConditions: ["capital_depleted", "deadline_reached", "max_loss_hit"],
      }));
      expect(material.stopConditions).toEqual([
        "capital_depleted",
        "deadline_reached",
        "max_loss_hit",
      ]);
    });

    it("drops empty / whitespace-only array items", () => {
      const material = buildContractMaterial(makeDraft({
        allowedChains: ["solana", "", "  "],
      }));
      expect(material.allowedChains).toEqual(["solana"]);
    });
  });
});
