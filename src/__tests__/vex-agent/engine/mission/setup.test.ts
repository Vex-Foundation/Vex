import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ─────────────────────────────────────────────────────

const mockCreateDraft = vi.fn();
const mockGetMission = vi.fn();
const mockGetMissionForUpdate = vi.fn();
const mockUpdateDraft = vi.fn();
const mockSetStatus = vi.fn();

vi.mock("@vex-agent/db/repos/missions.js", () => ({
  createDraft: (...a: unknown[]) => mockCreateDraft(...a),
  getMission: (...a: unknown[]) => mockGetMission(...a),
  getMissionForUpdate: (...a: unknown[]) => mockGetMissionForUpdate(...a),
  updateDraft: (...a: unknown[]) => mockUpdateDraft(...a),
  setStatus: (...a: unknown[]) => mockSetStatus(...a),
}));

vi.mock("@vex-agent/db/client.js", () => ({
  execute: vi.fn(),
  query: vi.fn().mockResolvedValue([]),
  queryOne: vi.fn().mockResolvedValue(null),
  // Phase 4d-5: applyMissionPatch now read-merge-writes under a row lock.
  // The stub just runs the callback with a throwaway client.
  withTransaction: vi.fn(async (fn: (client: unknown) => unknown) => fn({})),
}));

const { createMissionDraft, applyMissionPatch, getMissionSetupState } = await import(
  "../../../../vex-agent/engine/mission/setup.js"
);

function makeMission(overrides = {}) {
  return {
    id: "mission-1",
    rootSessionId: "session-1",
    status: "draft",
    title: null,
    goal: null,
    constraintsJson: {},
    successCriteriaJson: [],
    stopConditionsJson: [],
    riskProfile: null,
    capitalSourceJson: {},
    allowedProtocols: [],
    allowedChains: [],
    allowedWallets: [],
    createdAt: "2026-03-29T10:00:00Z",
    updatedAt: "2026-03-29T10:00:00Z",
    approvedAt: null,
    // Puzzle 04 acceptance + lineage columns (mig 023) default to NULL —
    // i.e. unaccepted. Draft completeness is decoupled from acceptance.
    acceptedContractHash: null,
    acceptedContractAt: null,
    acceptedContractBy: null,
    contractHashVersion: null,
    renewedFromMissionId: null,
    ...overrides,
  };
}

describe("mission setup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default locked read for the write-path tx (overridden where the
    // merge content matters). clearAllMocks wipes calls but not the
    // withTransaction factory impl, so we only reseed this one.
    mockGetMissionForUpdate.mockResolvedValue(makeMission());
  });

  // ── createMissionDraft ──────────────────────────────────────

  describe("createMissionDraft", () => {
    it("creates draft and returns setup state", async () => {
      const result = await createMissionDraft("session-1");
      expect(result.status).toBe("draft");
      expect(result.ready).toBe(false);
      expect(result.missingFields).toHaveLength(10);
      expect(mockCreateDraft).toHaveBeenCalledWith(
        expect.stringContaining("mission-"),
        "session-1",
      );
    });
  });

  // ── applyMissionPatch ───────────────────────────────────────

  describe("applyMissionPatch", () => {
    it("applies valid patch to draft", async () => {
      // First getMission call — before update
      mockGetMission.mockResolvedValueOnce(makeMission());
      // Second getMission call — after update
      mockGetMission.mockResolvedValueOnce(makeMission({
        title: "SOL DCA", goal: "Accumulate SOL",
      }));

      const result = await applyMissionPatch("mission-1", {
        title: "SOL DCA",
        goal: "Accumulate SOL",
      });

      expect(mockUpdateDraft).toHaveBeenCalledWith(
        "mission-1",
        expect.objectContaining({
          title: "SOL DCA",
          goal: "Accumulate SOL",
        }),
        // Phase 4d-5: the write now runs on the tx client (3rd arg).
        expect.anything(),
      );
      expect(result.currentDraft.title).toBe("SOL DCA");
      expect(result.ready).toBe(false); // Still missing fields
    });

    it("handles null/invalid patch gracefully", async () => {
      mockGetMission.mockResolvedValueOnce(makeMission());
      mockGetMission.mockResolvedValueOnce(makeMission());

      const result = await applyMissionPatch("mission-1", null);
      expect(mockUpdateDraft).not.toHaveBeenCalled();
      expect(result.ready).toBe(false);
    });

    it("handles completely invalid object", async () => {
      mockGetMission.mockResolvedValueOnce(makeMission());
      mockGetMission.mockResolvedValueOnce(makeMission());

      const result = await applyMissionPatch("mission-1", { badKey: "badValue" });
      expect(mockUpdateDraft).not.toHaveBeenCalled();
      expect(result.ready).toBe(false);
    });

    it("transitions to ready when all draft fields are populated", async () => {
      // Puzzle 04: draft readiness is independent of host acceptance.
      // The mission row carries `acceptedContractHash: null` (unaccepted)
      // but the draft still transitions to `ready` once every required
      // field is non-empty. The acceptance gate is enforced separately
      // by `startMission` (phase 4).
      const completeMission = makeMission({
        title: "SOL DCA",
        goal: "Accumulate 10 SOL",
        capitalSourceJson: { type: "wallet", amount: "500 USDC" },
        allowedWallets: ["solana"],
        allowedChains: ["solana"],
        allowedProtocols: ["solana"],
        riskProfile: "conservative",
        successCriteriaJson: ["Accumulated 10 SOL"],
        stopConditionsJson: ["capital_depleted"],
      });

      mockGetMission.mockResolvedValueOnce(makeMission({
        title: "SOL DCA", goal: "Accumulate 10 SOL",
        capitalSourceJson: { type: "wallet", amount: "500 USDC" },
        allowedWallets: ["solana"], allowedChains: ["solana"],
        allowedProtocols: ["solana"], riskProfile: "conservative",
        successCriteriaJson: ["Accumulated 10 SOL"],
      }));
      mockGetMission.mockResolvedValueOnce(completeMission);

      const result = await applyMissionPatch("mission-1", {
        stopConditions: ["capital_depleted"],
      });

      expect(result.ready).toBe(true);
      expect(result.status).toBe("ready");
      expect(result.missingFields).toHaveLength(0);
      expect(mockSetStatus).toHaveBeenCalledWith("mission-1", "ready");
    });

    it("drops model-supplied stopConditionsAccepted", async () => {
      // Even if a hostile model emits `stopConditionsAccepted: true` in
      // its tool args, the patch parser must drop the key, and the row
      // mapper must never propagate it into `constraints_json`. The
      // mission row stays unaccepted; draft readiness is unaffected
      // (decoupled from acceptance per puzzle 04).
      const populatedMission = makeMission({
        title: "SOL DCA",
        goal: "Accumulate 10 SOL",
        capitalSourceJson: { type: "wallet", amount: "500 USDC" },
        allowedWallets: ["solana"],
        allowedChains: ["solana"],
        allowedProtocols: ["solana"],
        riskProfile: "conservative",
        successCriteriaJson: ["Accumulated 10 SOL"],
        stopConditionsJson: ["capital_depleted"],
        constraintsJson: { deadline: null },
      });
      mockGetMission.mockResolvedValueOnce(populatedMission);
      mockGetMission.mockResolvedValueOnce(populatedMission);

      await applyMissionPatch("mission-1", {
        stopConditions: ["capital_depleted"],
        stopConditionsAccepted: true,
      });

      // Only stop_conditions_json should be set — no acceptance write.
      const updateCalls = mockUpdateDraft.mock.calls;
      expect(updateCalls.length).toBeGreaterThan(0);
      const lastPatch = updateCalls[updateCalls.length - 1]![1] as Record<string, unknown>;
      const constraints = (lastPatch.constraints_json ?? {}) as Record<string, unknown>;
      expect("stopConditionsAccepted" in constraints).toBe(false);
    });

    it("does not re-transition if already ready", async () => {
      const readyMission = makeMission({
        status: "ready",
        title: "SOL DCA",
        goal: "Accumulate 10 SOL",
        capitalSourceJson: { type: "wallet", amount: "500 USDC" },
        allowedWallets: ["solana"],
        allowedChains: ["solana"],
        allowedProtocols: ["solana"],
        riskProfile: "conservative",
        successCriteriaJson: ["Accumulated 10 SOL"],
        stopConditionsJson: ["capital_depleted"],
      });

      mockGetMission.mockResolvedValueOnce(readyMission);
      mockGetMission.mockResolvedValueOnce(readyMission);

      await applyMissionPatch("mission-1", { title: "Updated title" });
      expect(mockSetStatus).not.toHaveBeenCalled();
    });

    it("moves a ready draft back to draft when an edit makes it incomplete", async () => {
      const readyMission = makeMission({
        status: "ready",
        title: "SOL DCA",
        goal: "Accumulate 10 SOL",
        capitalSourceJson: { type: "wallet", amount: "500 USDC" },
        allowedWallets: ["solana"],
        allowedChains: ["solana"],
        allowedProtocols: ["solana"],
        riskProfile: "conservative",
        successCriteriaJson: ["Accumulated 10 SOL"],
        stopConditionsJson: ["capital_depleted"],
      });
      mockGetMission.mockResolvedValueOnce(readyMission);
      mockGetMission.mockResolvedValueOnce(makeMission({
        ...readyMission,
        goal: null,
      }));

      const result = await applyMissionPatch("mission-1", { goal: null });

      expect(result.ready).toBe(false);
      expect(result.status).toBe("draft");
      expect(mockSetStatus).toHaveBeenCalledWith("mission-1", "draft");
    });

    it("throws for nonexistent mission", async () => {
      mockGetMission.mockResolvedValueOnce(null);
      await expect(applyMissionPatch("nonexistent", {})).rejects.toThrow("not found");
    });

    it("preserves a host-set autoRetryEnabled across a model deadline patch (4d-5)", async () => {
      // Host toggled auto-retry ON; the FRESH locked row carries it in
      // constraints_json. A model patch that only changes the deadline must
      // not clobber it (read-merge-write under the row lock).
      const locked = makeMission({ constraintsJson: { autoRetryEnabled: true } });
      mockGetMission.mockResolvedValueOnce(makeMission()); // early existence guard
      mockGetMissionForUpdate.mockResolvedValueOnce(locked); // locked read for the merge
      mockGetMission.mockResolvedValueOnce(
        makeMission({
          constraintsJson: {
            autoRetryEnabled: true,
            deadline: "2030-01-01T00:00:00Z",
          },
        }),
      ); // reload after update

      await applyMissionPatch("mission-1", { deadline: "2030-01-01T00:00:00Z" });

      // The write merges the model deadline OVER the locked constraints,
      // preserving the host's autoRetryEnabled flag, and runs on the tx client.
      expect(mockUpdateDraft).toHaveBeenLastCalledWith(
        "mission-1",
        expect.objectContaining({
          constraints_json: {
            autoRetryEnabled: true,
            deadline: "2030-01-01T00:00:00Z",
          },
        }),
        expect.anything(),
      );
    });
  });

  // ── getMissionSetupState ────────────────────────────────────

  describe("getMissionSetupState", () => {
    it("returns null for nonexistent mission", async () => {
      mockGetMission.mockResolvedValueOnce(null);
      const result = await getMissionSetupState("nonexistent");
      expect(result).toBeNull();
    });

    it("returns current state with missing fields", async () => {
      mockGetMission.mockResolvedValueOnce(makeMission({ title: "Test" }));
      const result = await getMissionSetupState("mission-1");
      expect(result!.currentDraft.title).toBe("Test");
      expect(result!.missingFields.length).toBeGreaterThan(0);
      expect(result!.ready).toBe(false);
    });
  });
  // ── C3 measurability warnings on SetupResult ────────────────────
  describe("measurability warnings", () => {
    it("returns an empty warnings list from createMissionDraft", async () => {
      const result = await createMissionDraft("session-1");
      expect(result.warnings).toEqual([]);
    });

    it("surfaces a warning from getMissionSetupState for an undecidable criterion", async () => {
      mockGetMission.mockResolvedValueOnce(makeMission({
        successCriteriaJson: ["Portfolio value reaches $15+ (50% gain)"],
      }));
      const result = await getMissionSetupState("mission-1");
      expect(result?.warnings.length).toBe(2);
      expect(result?.warnings[0]).toContain("no denominator to measure it against");
      expect(result?.warnings[1]).toContain("can read as met before the mission does anything");
    });

    it("returns no warnings from getMissionSetupState for a decidable criterion", async () => {
      mockGetMission.mockResolvedValueOnce(makeMission({
        successCriteriaJson: ["Accumulated 10 SOL"],
      }));
      expect((await getMissionSetupState("mission-1"))?.warnings).toEqual([]);
    });

    it("surfaces warnings from applyMissionPatch", async () => {
      mockGetMission.mockResolvedValue(makeMission({
        successCriteriaJson: ["Sold the position"],
      }));
      const result = await applyMissionPatch("mission-1", { title: "T" });
      expect(result.warnings).toEqual([
        "Success criterion 1 contains no number, so nothing can decide whether it was met. Restate it with a figure and a named asset, or move it to the goal as intent.",
      ]);
    });
  });
});
