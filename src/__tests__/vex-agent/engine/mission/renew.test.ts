/**
 * Unit tests for `engine/mission/renew.ts`.
 *
 * Mission-runs + missions repo + clone helper are mocked. We assert
 * the discriminated-union outcomes for each precondition + the
 * happy path's clone call.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockGetMissionForUpdate = vi.fn();
const mockGetActiveRun = vi.fn();
const mockGetActiveRunBySession = vi.fn();
const mockCloneMissionAsDraft = vi.fn();

vi.mock("@vex-agent/db/repos/missions.js", () => ({
  getMissionForUpdate: (...a: unknown[]) => mockGetMissionForUpdate(...a),
}));

vi.mock("@vex-agent/db/repos/mission-runs.js", () => ({
  getActiveRun: (...a: unknown[]) => mockGetActiveRun(...a),
  getActiveRunBySession: (...a: unknown[]) => mockGetActiveRunBySession(...a),
}));

vi.mock("../../../../vex-agent/engine/mission/renew-internals.js", () => ({
  cloneMissionAsDraft: (...a: unknown[]) => mockCloneMissionAsDraft(...a),
}));

const fakeClientQuery = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });

vi.mock("@vex-agent/db/client.js", () => ({
  getPool: () => ({
    connect: async () => ({
      query: fakeClientQuery,
      release: vi.fn(),
    }),
  }),
  withTransaction: async (fn: (client: unknown) => Promise<unknown>) => {
    const fakeClient = { query: fakeClientQuery };
    await fakeClientQuery("BEGIN");
    try {
      const result = await fn(fakeClient);
      await fakeClientQuery("COMMIT");
      return result;
    } catch (err) {
      await fakeClientQuery("ROLLBACK");
      throw err;
    }
  },
  executeWith: vi.fn(),
}));

const { renewMission } = await import(
  "../../../../vex-agent/engine/mission/renew.js"
);
const { computeContractHash, LEGACY_CONTRACT_HASH_VERSION } = await import(
  "../../../../vex-agent/engine/mission/contract-hash.js"
);
const { missionToDraft } = await import(
  "../../../../vex-agent/engine/mission/mapper.js"
);

function makeMission(overrides: Record<string, unknown> = {}) {
  const mission = {
    id: "mission-source",
    rootSessionId: "session-1",
    status: "completed",
    title: "SOL DCA",
    goal: "Accumulate 10 SOL",
    constraintsJson: { deadline: "2026-04-04" },
    successCriteriaJson: ["Accumulated 10 SOL"],
    stopConditionsJson: ["capital_depleted"],
    riskProfile: "conservative",
    capitalSourceJson: { type: "wallet", amount: "500 USDC" },
    allowedProtocols: ["jupiter"],
    allowedChains: ["solana"],
    allowedWallets: ["solana"],
    createdAt: "2026-05-22T10:00:00.000Z",
    updatedAt: "2026-05-22T10:00:00.000Z",
    approvedAt: "2026-05-22T10:00:00.000Z",
    acceptedContractHash: "0".repeat(64),
    acceptedContractAt: "2026-05-22T10:00:00.000Z",
    acceptedContractBy: "host",
    contractHashVersion: 1,
    renewedFromMissionId: null,
    ...overrides,
  };
  return {
    ...mission,
    // Key-presence check: an explicit `acceptedContractHash: null` override
    // (the never-accepted case) must survive — `??` would silently re-hash it.
    acceptedContractHash: "acceptedContractHash" in overrides
      ? overrides["acceptedContractHash"]
      : computeContractHash(missionToDraft(mission), LEGACY_CONTRACT_HASH_VERSION),
  };
}

describe("renewMission", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns previous_mission_not_found when source is missing", async () => {
    mockGetMissionForUpdate.mockResolvedValueOnce(null);
    const outcome = await renewMission({
      sessionId: "session-1",
      previousMissionId: "missing",
    });
    expect(outcome.outcome).toBe("previous_mission_not_found");
    expect(mockCloneMissionAsDraft).not.toHaveBeenCalled();
  });

  it("returns session_mismatch when source belongs to another session", async () => {
    mockGetMissionForUpdate.mockResolvedValueOnce(
      makeMission({ rootSessionId: "OTHER" }),
    );
    const outcome = await renewMission({
      sessionId: "session-1",
      previousMissionId: "mission-source",
    });
    expect(outcome.outcome).toBe("session_mismatch");
    if (outcome.outcome === "session_mismatch") {
      expect(outcome.expectedSessionId).toBe("OTHER");
    }
  });

  it("returns not_accepted when source was never accepted", async () => {
    mockGetMissionForUpdate.mockResolvedValueOnce(
      makeMission({ acceptedContractHash: null }),
    );
    const outcome = await renewMission({
      sessionId: "session-1",
      previousMissionId: "mission-source",
    });
    expect(outcome.outcome).toBe("not_accepted");
    if (outcome.outcome === "not_accepted") {
      expect(outcome.sourceMissionId).toBe("mission-source");
    }
  });

  it("returns not_terminal_yet when source mission still has a live run", async () => {
    mockGetMissionForUpdate.mockResolvedValueOnce(makeMission());
    mockGetActiveRun.mockResolvedValueOnce({
      id: "run-source",
      status: "paused_user",
    });
    const outcome = await renewMission({
      sessionId: "session-1",
      previousMissionId: "mission-source",
    });
    expect(outcome.outcome).toBe("not_terminal_yet");
    if (outcome.outcome === "not_terminal_yet") {
      expect(outcome.runStatus).toBe("paused_user");
    }
  });

  it("returns session_has_active_run when another mission is live in the session", async () => {
    mockGetMissionForUpdate.mockResolvedValueOnce(makeMission());
    mockGetActiveRun.mockResolvedValueOnce(null);
    mockGetActiveRunBySession.mockResolvedValueOnce({
      id: "run-other",
      status: "running",
    });
    const outcome = await renewMission({
      sessionId: "session-1",
      previousMissionId: "mission-source",
    });
    expect(outcome.outcome).toBe("session_has_active_run");
    if (outcome.outcome === "session_has_active_run") {
      expect(outcome.missionRunId).toBe("run-other");
    }
  });

  it("creates a new mission draft via cloneMissionAsDraft on the happy path", async () => {
    mockGetMissionForUpdate.mockResolvedValueOnce(makeMission());
    mockGetActiveRun.mockResolvedValueOnce(null);
    mockGetActiveRunBySession.mockResolvedValueOnce(null);

    const outcome = await renewMission({
      sessionId: "session-1",
      previousMissionId: "mission-source",
    });

    expect(outcome.outcome).toBe("renewed");
    if (outcome.outcome === "renewed") {
      expect(outcome.sourceMissionId).toBe("mission-source");
      expect(outcome.newMissionId).toMatch(/^mission-\d+-[0-9a-f]{8}$/);
    }
    expect(mockCloneMissionAsDraft).toHaveBeenCalledTimes(1);
    const args = mockCloneMissionAsDraft.mock.calls[0]!;
    // (client, sourceMissionId, newMissionId, targetSessionId)
    expect(args[1]).toBe("mission-source");
    expect(args[3]).toBe("session-1");
  });

  it("does not call the clone helper when any precondition fails", async () => {
    mockGetMissionForUpdate.mockResolvedValueOnce(
      makeMission({ acceptedContractHash: null }),
    );
    await renewMission({
      sessionId: "session-1",
      previousMissionId: "mission-source",
    });
    expect(mockCloneMissionAsDraft).not.toHaveBeenCalled();
  });

  it("runs getActiveRunBySession inside the transaction (passes the tx client)", async () => {
    // Codex required this to ride the same tx as the source-mission
    // row lock — otherwise the read could miss a run that was just
    // started in another tx. The repo signature was widened to accept
    // an optional `client`; here we assert the engine helper passes it.
    mockGetMissionForUpdate.mockResolvedValueOnce(makeMission());
    mockGetActiveRun.mockResolvedValueOnce(null);
    mockGetActiveRunBySession.mockResolvedValueOnce(null);

    await renewMission({
      sessionId: "session-1",
      previousMissionId: "mission-source",
    });

    expect(mockGetActiveRunBySession).toHaveBeenCalledTimes(1);
    const args = mockGetActiveRunBySession.mock.calls[0]!;
    expect(args[0]).toBe("session-1");
    // The second arg is the tx client (truthy object).
    expect(args[1]).toBeDefined();
    expect(typeof args[1]).toBe("object");
  });
});
