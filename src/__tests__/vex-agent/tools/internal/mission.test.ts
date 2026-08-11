import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeTestContext } from "../_test-context.js";

const mockApplyMissionPatch = vi.fn();
const mockGetRunBySession = vi.fn();
const mockGetMission = vi.fn();

vi.mock("@vex-agent/engine/mission/setup.js", () => ({
  applyMissionPatch: (...a: unknown[]) => mockApplyMissionPatch(...a),
}));

vi.mock("@vex-agent/db/repos/mission-runs.js", () => ({
  getRunBySession: (...a: unknown[]) => mockGetRunBySession(...a),
}));

vi.mock("@vex-agent/db/repos/missions.js", () => ({
  getMission: (...a: unknown[]) => mockGetMission(...a),
}));

vi.mock("@vex-agent/db/client.js", () => ({
  execute: vi.fn(), query: vi.fn().mockResolvedValue([]), queryOne: vi.fn().mockResolvedValue(null),
}));

const { handleMissionDraftUpdate, handleMissionStop } = await import("../../../../vex-agent/tools/internal/mission.js");

const baseContext = makeTestContext({
  sessionId: "session-1",
  sessionPermission: "restricted",
  missionRunId: "run-1",
  missionId: "mission-1",
  sessionKind: "mission",
});

beforeEach(() => {
  mockApplyMissionPatch.mockReset();
  mockGetRunBySession.mockReset();
  mockGetMission.mockReset();
  mockGetRunBySession.mockResolvedValue(null);
  mockGetMission.mockResolvedValue({
    id: "mission-1",
    status: "running",
    stopConditionsJson: [
      "deadline_reached",
      "capital_depleted",
      "max_loss_hit",
      "no_viable_opportunity",
    ],
    // Puzzle 04: acceptance reads `acceptedContractHash !== null`.
    // Hash content is opaque to the authorizer.
    acceptedContractHash: "0".repeat(64),
  });
});

describe("mission_draft_update tool", () => {
  it("applies a draft patch in mission setup", async () => {
    mockApplyMissionPatch.mockResolvedValueOnce({
      missionId: "mission-1",
      status: "ready",
      currentDraft: { title: "SOL Flip" },
      missingFields: [],
      ready: true,
      warnings: [],
    });

    const result = await handleMissionDraftUpdate(
      { title: "SOL Flip", goal: "Double wallet value" },
      { ...baseContext, missionRunId: null },
    );

    expect(result.success).toBe(true);
    expect(mockApplyMissionPatch).toHaveBeenCalledWith("mission-1", {
      title: "SOL Flip",
      goal: "Double wallet value",
    });
    expect(result.data).toEqual(expect.objectContaining({
      ready: true,
      nextAction:
        "The draft is ready — tell the user they can start the mission with the Start mission button in the host UI.",
    }));
  });

  it("passes stop condition updates through the setup boundary", async () => {
    // Puzzle 04: draft can be `ready` once the list is non-empty —
    // acceptance is a separate host gate (mission.acceptContract → mig
    // 023 `accepted_contract_hash`). The setup boundary surfaces the
    // current draft as-is; no model-facing acceptance flag is exposed.
    mockApplyMissionPatch.mockResolvedValueOnce({
      missionId: "mission-1",
      status: "ready",
      currentDraft: { stopConditions: ["capital_depleted"] },
      missingFields: [],
      ready: true,
      warnings: [],
    });

    const result = await handleMissionDraftUpdate(
      { stopConditions: ["capital_depleted"] },
      { ...baseContext, missionRunId: null },
    );

    expect(result.success).toBe(true);
    expect(mockApplyMissionPatch).toHaveBeenCalledWith("mission-1", {
      stopConditions: ["capital_depleted"],
    });
  });

  it("passes a numeric durationMinutes through the setup boundary", async () => {
    // Regression: durationMinutes is model-set NUMERIC data (a whole-minute
    // time-box). It must reach applyMissionPatch as a number, not be dropped
    // by a string-only sanitizer (see patch-parser.ts).
    mockApplyMissionPatch.mockResolvedValueOnce({
      missionId: "mission-1",
      status: "ready",
      currentDraft: { durationMinutes: 30 },
      missingFields: [],
      ready: true,
      warnings: [],
    });

    const result = await handleMissionDraftUpdate(
      { durationMinutes: 30 },
      { ...baseContext, missionRunId: null },
    );

    expect(result.success).toBe(true);
    expect(mockApplyMissionPatch).toHaveBeenCalledWith("mission-1", {
      durationMinutes: 30,
    });
  });

  it("rejects a non-numeric durationMinutes", async () => {
    const result = await handleMissionDraftUpdate(
      { durationMinutes: "30 minutes" },
      { ...baseContext, missionRunId: null },
    );
    expect(result.success).toBe(false);
    expect(mockApplyMissionPatch).not.toHaveBeenCalled();
  });

  it("returns the continue-button hint when a prior run exists", async () => {
    mockApplyMissionPatch.mockResolvedValueOnce({
      missionId: "mission-1",
      status: "ready",
      currentDraft: { title: "SOL Flip" },
      missingFields: [],
      ready: true,
      warnings: [],
    });
    mockGetRunBySession.mockResolvedValueOnce({ id: "run-prior" });

    const result = await handleMissionDraftUpdate(
      { title: "SOL Flip" },
      { ...baseContext, missionRunId: null },
    );

    expect(result.success).toBe(true);
    expect(result.data?.nextAction).toBe(
      "The draft is ready — tell the user they can continue the mission with the Continue button in the host UI.",
    );
  });

  it("rejects outside mission setup", async () => {
    const result = await handleMissionDraftUpdate(
      { title: "SOL Flip" },
      baseContext,
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain("only valid during mission setup or edit");
  });

  it("rejects invalid patch shape", async () => {
    const result = await handleMissionDraftUpdate(
      { allowedWallets: ["ok", ""] },
      { ...baseContext, missionRunId: null },
    );
    expect(result.success).toBe(false);
    expect(mockApplyMissionPatch).not.toHaveBeenCalledWith("mission-1", expect.objectContaining({
      allowedWallets: expect.anything(),
    }));
  });

  it("omits currentDraft from the output string in concise mode (default)", async () => {
    mockApplyMissionPatch.mockResolvedValueOnce({
      missionId: "mission-1",
      status: "ready",
      currentDraft: { title: "SOL Flip" },
      missingFields: [],
      ready: true,
      warnings: [],
    });

    const result = await handleMissionDraftUpdate(
      { title: "SOL Flip" },
      { ...baseContext, missionRunId: null },
    );

    expect(result.success).toBe(true);
    // response_format is tool-only — it must not leak into the setup patch.
    expect(mockApplyMissionPatch).toHaveBeenCalledWith("mission-1", { title: "SOL Flip" });

    // Output string (model-facing) drops the bulky currentDraft but keeps nextAction.
    const output = JSON.parse(result.output) as Record<string, unknown>;
    expect(output).not.toHaveProperty("currentDraft");
    expect(output.missionId).toBe("mission-1");
    expect(output.status).toBe("ready");
    expect(output.ready).toBe(true);
    expect(output.missingFields).toEqual([]);
    expect(output.nextAction).toBe(
      "The draft is ready — tell the user they can start the mission with the Start mission button in the host UI.",
    );

    // result.data (host-facing) is untouched — currentDraft still present.
    expect(result.data).toEqual({
      missionId: "mission-1",
      status: "ready",
      ready: true,
      missingFields: [],
      currentDraft: { title: "SOL Flip" },
      nextAction:
        "The draft is ready — tell the user they can start the mission with the Start mission button in the host UI.",
    });
  });

  it("includes currentDraft in the output string when response_format='detailed'", async () => {
    mockApplyMissionPatch.mockResolvedValueOnce({
      missionId: "mission-1",
      status: "ready",
      currentDraft: { title: "SOL Flip" },
      missingFields: [],
      ready: true,
      warnings: [],
    });

    const result = await handleMissionDraftUpdate(
      { title: "SOL Flip", response_format: "detailed" },
      { ...baseContext, missionRunId: null },
    );

    expect(result.success).toBe(true);
    // response_format is stripped before the setup patch — only draft fields pass through.
    expect(mockApplyMissionPatch).toHaveBeenCalledWith("mission-1", { title: "SOL Flip" });

    // Output string carries currentDraft in detailed mode, still with nextAction.
    const output = JSON.parse(result.output) as Record<string, unknown>;
    expect(output.currentDraft).toEqual({ title: "SOL Flip" });
    expect(output.nextAction).toBe(
      "The draft is ready — tell the user they can start the mission with the Start mission button in the host UI.",
    );

    // result.data (host-facing) is identical regardless of response_format.
    expect(result.data).toEqual({
      missionId: "mission-1",
      status: "ready",
      ready: true,
      missingFields: [],
      currentDraft: { title: "SOL Flip" },
      nextAction:
        "The draft is ready — tell the user they can start the mission with the Start mission button in the host UI.",
    });
  });
});

describe("mission_stop tool", () => {
  it("returns engineSignal with valid reason", async () => {
    const result = await handleMissionStop(
      { reason: "goal_reached", summary: "Accumulated target SOL" },
      baseContext,
    );
    expect(result.success).toBe(true);
    expect(result.engineSignal).toBeDefined();
    expect(result.engineSignal!.type).toBe("stop_mission");
    expect(result.engineSignal!.reason).toBe("goal_reached");
    expect(result.engineSignal!.summary).toBe("Accumulated target SOL");
  });

  it("accepts all valid stop reasons", async () => {
    const reasons = ["goal_reached", "deadline_reached", "capital_depleted", "max_loss_hit", "no_viable_opportunity", "emergency_stop"];
    for (const reason of reasons) {
      const result = await handleMissionStop({ reason, summary: "test" }, baseContext);
      expect(result.success).toBe(true);
      expect(result.engineSignal!.reason).toBe(reason);
    }
  });

  it("rejects invalid reason", async () => {
    const result = await handleMissionStop(
      { reason: "bored", summary: "I'm bored" },
      baseContext,
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain("Invalid stop reason");
  });

  it("requires reason", async () => {
    const result = await handleMissionStop({ summary: "test" }, baseContext);
    expect(result.success).toBe(false);
    expect(result.output).toContain("Missing required: reason");
  });

  it("requires summary", async () => {
    const result = await handleMissionStop({ reason: "goal_reached" }, baseContext);
    expect(result.success).toBe(false);
    expect(result.output).toContain("Missing required: summary");
  });

  it("includes optional evidence", async () => {
    const result = await handleMissionStop(
      { reason: "capital_depleted", summary: "No funds left", evidence: { balanceUsd: 0.12 } },
      baseContext,
    );
    expect(result.engineSignal!.evidence).toEqual({ balanceUsd: 0.12 });
  });

  it("rejects unaccepted user-configurable stop reasons", async () => {
    mockGetMission.mockResolvedValueOnce({
      id: "mission-1",
      status: "running",
      stopConditionsJson: ["deadline_reached"],
      acceptedContractHash: "0".repeat(64),
    });

    const result = await handleMissionStop(
      { reason: "no_viable_opportunity", summary: "No setup right now" },
      baseContext,
    );

    expect(result.success).toBe(false);
    expect(result.output).toContain("not in the accepted mission stop conditions");
  });

  it("allows emergency_stop without a configured stop condition", async () => {
    mockGetMission.mockReset();
    const result = await handleMissionStop(
      { reason: "emergency_stop", summary: "Wallet state cannot be verified" },
      baseContext,
    );

    expect(result.success).toBe(true);
    expect(mockGetMission).not.toHaveBeenCalled();
    expect(result.engineSignal!.reason).toBe("emergency_stop");
  });

  it("rejects when no active mission run (missionRunId null)", async () => {
    const result = await handleMissionStop(
      { reason: "goal_reached", summary: "Done" },
      { ...baseContext, missionRunId: null },
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain("only valid during an active mission run");
  });

  it("rejects user_stopped (not a model-driven reason)", async () => {
    const result = await handleMissionStop(
      { reason: "user_stopped", summary: "user asked" },
      baseContext,
    );
    expect(result.success).toBe(false);
  });
  // ── C3 measurability warnings ───────────────────────────────────
  describe("measurability warnings", () => {
    function mockResultWithWarnings(warnings: string[]) {
      mockApplyMissionPatch.mockResolvedValueOnce({
        missionId: "mission-1",
        status: "draft",
        currentDraft: { title: "SOL Flip" },
        missingFields: ["goal"],
        ready: false,
        warnings,
      });
    }

    it("surfaces warnings in the model-facing output in BOTH response formats", async () => {
      for (const response_format of ["concise", "detailed"]) {
        mockResultWithWarnings(["no denominator to measure it against"]);
        const result = await handleMissionDraftUpdate(
          { title: "SOL Flip", response_format },
          { ...baseContext, missionRunId: null },
        );
        expect(JSON.parse(result.output as string).warnings).toEqual([
          "no denominator to measure it against",
        ]);
      }
    });

    it("keeps warnings OUT of the host-facing data block", async () => {
      mockResultWithWarnings(["no denominator to measure it against"]);
      const result = await handleMissionDraftUpdate(
        { title: "SOL Flip" },
        { ...baseContext, missionRunId: null },
      );
      expect("warnings" in (result.data as object)).toBe(false);
    });

    it("omits the key entirely when there is nothing to warn about", async () => {
      mockResultWithWarnings([]);
      const result = await handleMissionDraftUpdate(
        { title: "SOL Flip" },
        { ...baseContext, missionRunId: null },
      );
      expect("warnings" in JSON.parse(result.output as string)).toBe(false);
    });

    it("accepts a well-formed deployedCapital through the tool schema", async () => {
      mockResultWithWarnings([]);
      const declared = {
        amountRaw: "3044000000000000000000",
        decimals: 18,
        chainId: 4663,
        assetAddress: "0x0f9f0000000000000000000000000000000000ee",
        assetSymbol: "VEX",
      };
      const result = await handleMissionDraftUpdate(
        { deployedCapital: declared },
        { ...baseContext, missionRunId: null },
      );
      expect(result.success).toBe(true);
      expect(mockApplyMissionPatch).toHaveBeenCalledWith("mission-1", { deployedCapital: declared });
    });

    it("reports a LOCATED path when the model sends a partial deployedCapital", async () => {
      const result = await handleMissionDraftUpdate(
        { deployedCapital: { amountRaw: "3044", decimals: 18, chainId: 4663, assetAddress: "0x0f9f0000000000000000000000000000000000ee" } },
        { ...baseContext, missionRunId: null },
      );
      expect(result.success).toBe(false);
      expect(result.output).toContain("deployedCapital.assetSymbol");
    });
  });
});
