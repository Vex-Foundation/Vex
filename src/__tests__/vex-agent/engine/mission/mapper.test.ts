import { describe, it, expect } from "vitest";

import { missionToDraft, domainToRow, freezeDraft, draftToPromptContext } from "../../../../vex-agent/engine/mission/mapper.js";
import type { Mission } from "../../../../vex-agent/db/repos/missions.js";

function makeMission(overrides: Partial<Mission> = {}): Mission {
  return {
    id: "mission-1",
    rootSessionId: "session-1",
    status: "ready",
    title: "SOL DCA",
    goal: "Accumulate 10 SOL over 7 days",
    constraintsJson: { deadline: "2026-04-04" },
    successCriteriaJson: ["Accumulated 10 SOL"],
    stopConditionsJson: ["capital_depleted", "deadline_reached"],
    riskProfile: "conservative",
    capitalSourceJson: { type: "wallet", amount: "500 USDC" },
    allowedProtocols: ["solana"],
    allowedChains: ["solana"],
    allowedWallets: ["solana"],
    createdAt: "2026-03-28T10:00:00Z",
    updatedAt: "2026-03-28T10:00:00Z",
    approvedAt: "2026-03-28T10:05:00Z",
    // Puzzle 04 acceptance + lineage columns (mig 023). Defaults to
    // unaccepted; tests opt in by overriding when needed.
    acceptedContractHash: null,
    acceptedContractAt: null,
    acceptedContractBy: null,
    contractHashVersion: null,
    renewedFromMissionId: null,
    ...overrides,
  };
}

describe("mission mapper", () => {
  // ── missionToDraft ──────────────────────────────────────────

  describe("missionToDraft", () => {
    // Characterization: the WHOLE projected draft, field for field. Captured
    // before the deployed-capital work so a new field is a visible, deliberate
    // line in this object rather than a silent widening of the domain model.
    it("pins the full projected draft for a fixture row", () => {
      expect(missionToDraft(makeMission())).toEqual({
        title: "SOL DCA",
        goal: "Accumulate 10 SOL over 7 days",
        capitalSource: "wallet",
        startingCapital: "500 USDC",
        deployedCapital: null,
        allowedWallets: ["solana"],
        allowedChains: ["solana"],
        allowedProtocols: ["solana"],
        riskProfile: "conservative",
        successCriteria: ["Accumulated 10 SOL"],
        stopConditions: ["capital_depleted", "deadline_reached"],
        deadline: "2026-04-04",
        durationMinutes: null,
        maxLaunchValueRaw: null,
        maxLaunchValueDecimals: null,
        maxLaunchCount: null,
      });
    });

    it("converts Mission row to domain MissionDraft", () => {
      const draft = missionToDraft(makeMission());
      expect(draft.title).toBe("SOL DCA");
      expect(draft.goal).toBe("Accumulate 10 SOL over 7 days");
      expect(draft.capitalSource).toBe("wallet");
      expect(draft.startingCapital).toBe("500 USDC");
      expect(draft.allowedChains).toEqual(["solana"]);
      expect(draft.riskProfile).toBe("conservative");
      expect(draft.successCriteria).toEqual(["Accumulated 10 SOL"]);
      expect(draft.stopConditions).toEqual(["capital_depleted", "deadline_reached"]);
      expect(draft.deadline).toBe("2026-04-04");
    });

    it("returns null for empty fields", () => {
      const draft = missionToDraft(makeMission({
        title: null, goal: null, riskProfile: null,
        capitalSourceJson: {}, allowedChains: [], allowedProtocols: [],
        allowedWallets: [], successCriteriaJson: [], stopConditionsJson: [],
        constraintsJson: {},
      }));
      expect(draft.title).toBeNull();
      expect(draft.goal).toBeNull();
      expect(draft.capitalSource).toBeNull();
      expect(draft.startingCapital).toBeNull();
      expect(draft.allowedChains).toBeNull();
      expect(draft.deadline).toBeNull();
      expect(draft.durationMinutes).toBeNull();
    });

    it("reads a numeric durationMinutes from constraints", () => {
      const draft = missionToDraft(makeMission({
        constraintsJson: { deadline: "2026-04-04", durationMinutes: 30 },
      }));
      expect(draft.durationMinutes).toBe(30);
    });

    it("ignores a non-numeric durationMinutes on legacy/malformed rows", () => {
      const draft = missionToDraft(makeMission({
        constraintsJson: { durationMinutes: "30" },
      }));
      expect(draft.durationMinutes).toBeNull();
    });

    it("ignores legacy constraints_json.stopConditionsAccepted on old rows", () => {
      // Mission rows written before puzzle 04 may carry a leftover
      // `stopConditionsAccepted: true` inside constraints_json. The
      // mapper must NOT surface it onto MissionDraft anymore — the
      // field is gone and acceptance reads come from
      // `missions.accepted_contract_hash`.
      const draft = missionToDraft(makeMission({
        constraintsJson: { stopConditionsAccepted: true, deadline: "2026-04-04" },
      }));
      expect(draft.deadline).toBe("2026-04-04");
      expect("stopConditionsAccepted" in draft).toBe(false);
    });
  });

  // ── domainToRow ─────────────────────────────────────────────

  describe("domainToRow", () => {
    it("converts domain fields to DB row shape", () => {
      const row = domainToRow({
        title: "Test",
        goal: "Test goal",
        riskProfile: "aggressive",
        allowedChains: ["solana", "ethereum"],
      });
      expect(row.title).toBe("Test");
      expect(row.goal).toBe("Test goal");
      expect(row.risk_profile).toBe("aggressive");
      expect(row.allowed_chains).toEqual(["solana", "ethereum"]);
    });

    it("converts capitalSource + startingCapital to capital_source_json", () => {
      const row = domainToRow({
        capitalSource: "wallet",
        startingCapital: "1000 USDC",
      });
      expect(row.capital_source_json).toEqual({ type: "wallet", amount: "1000 USDC" });
    });

    it("converts deadline to constraints_json", () => {
      const row = domainToRow({ deadline: "2026-04-04" });
      expect(row.constraints_json).toEqual({ deadline: "2026-04-04" });
    });

    it("converts durationMinutes to constraints_json", () => {
      const row = domainToRow({ deadline: "2026-04-04", durationMinutes: 30 });
      expect(row.constraints_json).toEqual({ deadline: "2026-04-04", durationMinutes: 30 });
    });

    it("does not write a stopConditionsAccepted key", () => {
      // Even if a stray boolean reaches domainToRow via legacy code,
      // the row mapper must never emit a `stopConditionsAccepted` JSONB
      // field — acceptance lives on `missions.accepted_contract_hash`,
      // not in constraints_json. This pins the boundary against drift.
      const row = domainToRow({
        deadline: "2026-04-04",
        // @ts-expect-error — the field no longer exists on MissionDraft.
        stopConditionsAccepted: true,
      });
      expect(row.constraints_json).toEqual({ deadline: "2026-04-04" });
      const constraints = row.constraints_json as Record<string, unknown>;
      expect("stopConditionsAccepted" in constraints).toBe(false);
    });

    it("converts null arrays to empty arrays", () => {
      const row = domainToRow({ allowedChains: null });
      expect(row.allowed_chains).toEqual([]);
    });

    it("skips undefined fields", () => {
      const row = domainToRow({ title: "Only title" });
      expect(row.title).toBe("Only title");
      expect(row.goal).toBeUndefined();
      expect(row.risk_profile).toBeUndefined();
    });

    it("returns empty object for empty input", () => {
      const row = domainToRow({});
      expect(Object.keys(row)).toHaveLength(0);
    });
  });

  // ── freezeDraft ─────────────────────────────────────────────

  describe("freezeDraft", () => {
    it("creates frozen mission snapshot", () => {
      const frozen = freezeDraft(makeMission());
      expect(frozen.id).toBe("mission-1");
      expect(frozen.title).toBe("SOL DCA");
      expect(frozen.goal).toBe("Accumulate 10 SOL over 7 days");
      expect(frozen.draft.allowedChains).toEqual(["solana"]);
      expect(frozen.approvedAt).toBe("2026-03-28T10:05:00Z");
    });

    it("uses defaults for null title/goal", () => {
      const frozen = freezeDraft(makeMission({ title: null, goal: null, approvedAt: null }));
      expect(frozen.title).toBe("Untitled Mission");
      expect(frozen.goal).toBe("");
    });
  });

  // ── draftToPromptContext ────────────────────────────────────

  describe("draftToPromptContext", () => {
    it("generates readable summary", () => {
      const ctx = draftToPromptContext(makeMission());
      expect(ctx).toContain("SOL DCA");
      expect(ctx).toContain("Accumulate 10 SOL");
      expect(ctx).toContain("wallet");
      expect(ctx).toContain("500 USDC");
      expect(ctx).toContain("conservative");
      expect(ctx).toContain("solana");
      expect(ctx).toContain("Accumulated 10 SOL");
      expect(ctx).toContain("2026-04-04");
    });

    it("includes the time-box when durationMinutes is set", () => {
      const ctx = draftToPromptContext(makeMission({
        constraintsJson: { deadline: "2026-04-04", durationMinutes: 30 },
      }));
      expect(ctx).toContain("30 min");
    });

    it("handles empty mission gracefully", () => {
      const ctx = draftToPromptContext(makeMission({
        title: null, goal: null, riskProfile: null,
        capitalSourceJson: {}, allowedChains: [], constraintsJson: {},
      }));
      expect(ctx).toContain("(untitled)");
      expect(ctx).not.toContain("undefined");
    });
  });
  // ── C3 deployed capital ─────────────────────────────────────
  describe("deployedCapital", () => {
    const DECLARED = {
      amountRaw: "3044000000000000000000",
      decimals: 18,
      chainId: 4663,
      assetAddress: "0x0f9f0000000000000000000000000000000000ee",
      assetKind: "token" as const,
      assetSymbol: "VEX",
    };

    it("round-trips a declaration through domainToRow and back", () => {
      const row = domainToRow({ deployedCapital: DECLARED });
      const draft = missionToDraft(makeMission({
        capitalSourceJson: row.capital_source_json as Record<string, unknown>,
      }));
      expect(draft.deployedCapital).toEqual(DECLARED);
    });

    it("reads a PARTIAL or malformed stored blob as absent, never as a usable denominator", () => {
      for (const stored of [
        { amountRaw: "1000" },
        { ...DECLARED, decimals: undefined },
        { ...DECLARED, amountRaw: "0" },
        { ...DECLARED, assetAddress: "not-an-address" },
        "a string",
        null,
      ]) {
        const draft = missionToDraft(makeMission({
          capitalSourceJson: { type: "wallet", amount: "500 USDC", deployedCapital: stored },
        }));
        expect(draft.deployedCapital).toBeNull();
      }
    });

    it("writes the declaration WITHOUT dropping type or amount on a capital-only patch", () => {
      // domainToRow emits only the keys the patch carried; `setup.ts`
      // read-merge-writes the blob under the row lock, so the untouched
      // `type`/`amount` survive. This pins that the writer does not clobber them.
      const row = domainToRow({ deployedCapital: DECLARED });
      expect(row.capital_source_json).toEqual({ deployedCapital: DECLARED });
      expect("type" in (row.capital_source_json as object)).toBe(false);
      expect("amount" in (row.capital_source_json as object)).toBe(false);
    });

    it("writes an explicit null so the declaration can be cleared", () => {
      expect(domainToRow({ deployedCapital: null }).capital_source_json).toEqual({
        deployedCapital: null,
      });
    });

    it("emits no capital blob at all when no capital key was patched", () => {
      expect(domainToRow({ goal: "x" }).capital_source_json).toBeUndefined();
    });

    it("renders the prompt line with the human figure and the not-a-spend-limit clause", () => {
      const context = draftToPromptContext(makeMission({
        capitalSourceJson: { type: "wallet", amount: "500 USDC", deployedCapital: DECLARED },
      }));
      expect(context).toContain("**Deployed capital:** 3044 VEX (raw 3044000000000000000000 at 18 decimals) on chain 4663, asset 0x0f9f0000000000000000000000000000000000ee, kind token. This is the declared measurement base, not a spend limit.");
    });

    it("omits the prompt line entirely when nothing was declared", () => {
      expect(draftToPromptContext(makeMission())).not.toContain("**Deployed capital:**");
    });
  });
});
