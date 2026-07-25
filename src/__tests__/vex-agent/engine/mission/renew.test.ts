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
const mockLockSessionForRenew = vi.fn();
const mockGetPendingDraftForSession = vi.fn();
const mockReconcileDraftReadiness = vi.fn();

vi.mock("@vex-agent/db/repos/missions.js", () => ({
  getMissionForUpdate: (...a: unknown[]) => mockGetMissionForUpdate(...a),
  lockSessionForRenew: (...a: unknown[]) => mockLockSessionForRenew(...a),
  getPendingDraftForSession: (...a: unknown[]) =>
    mockGetPendingDraftForSession(...a),
}));

vi.mock("@vex-agent/db/repos/mission-runs.js", () => ({
  getActiveRun: (...a: unknown[]) => mockGetActiveRun(...a),
  getActiveRunBySession: (...a: unknown[]) => mockGetActiveRunBySession(...a),
}));

vi.mock("../../../../vex-agent/engine/mission/renew-internals.js", () => ({
  cloneMissionAsDraft: (...a: unknown[]) => mockCloneMissionAsDraft(...a),
}));

// `cloneMissionAsDraft` returns `Promise<void>` (see renew-internals.ts) —
// its mock cannot return a row, so the complete→ready / incomplete→draft
// behavior is NOT testable here. That behavior lives in
// `draft-readiness.test.ts`; this file only asserts the wiring: called
// with the NEW mission id and the SAME tx client the clone used.
vi.mock("../../../../vex-agent/engine/mission/draft-readiness.js", () => ({
  reconcileDraftReadiness: (...a: unknown[]) =>
    mockReconcileDraftReadiness(...a),
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
const { computeContractHash, LEGACY_CONTRACT_HASH_VERSION, LEGACY_V2_CONTRACT_HASH_VERSION } = await import(
  "../../../../vex-agent/engine/mission/contract-hash.js"
);
const { extractLegacyHyperliquidRiskV2, missionToDraft } = await import(
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
    mockLockSessionForRenew.mockResolvedValue(undefined);
    mockGetPendingDraftForSession.mockResolvedValue(null);
    mockReconcileDraftReadiness.mockResolvedValue({ promoted: false });
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

  // Agent Scan Phase 3 (Hyperliquid removal): a mission accepted while
  // `CONTRACT_HASH_VERSION` was 2 must still be renewable — the frozen v2
  // legacy material (`contract-hash-legacy-v2.ts`) reproduces its exact
  // original hash from the raw `constraints_json.hyperliquidRisk` this
  // source mission still carries, even though `MissionDraft` no longer
  // surfaces it.
  it("renews a source mission accepted under the frozen legacy v2 contract hash (historical Hyperliquid risk)", async () => {
    const hyperliquidRisk = { leverageCap: 3, perOrderNotionalPct: 20, totalNotionalPct: 100 };
    const source = makeMission({
      constraintsJson: { deadline: "2026-04-04", hyperliquidRisk },
      contractHashVersion: LEGACY_V2_CONTRACT_HASH_VERSION,
    });
    const legacyHash = computeContractHash(
      missionToDraft(source),
      LEGACY_V2_CONTRACT_HASH_VERSION,
      extractLegacyHyperliquidRiskV2(source),
    );
    mockGetMissionForUpdate.mockResolvedValueOnce({ ...source, acceptedContractHash: legacyHash });
    mockGetActiveRun.mockResolvedValueOnce(null);
    mockGetActiveRunBySession.mockResolvedValueOnce(null);

    const outcome = await renewMission({
      sessionId: "session-1",
      previousMissionId: "mission-source",
    });

    expect(outcome.outcome).toBe("renewed");
    expect(mockCloneMissionAsDraft).toHaveBeenCalledTimes(1);
  });

  it("reconciles the NEW mission's draft readiness in the SAME tx client as the clone", async () => {
    mockGetMissionForUpdate.mockResolvedValueOnce(makeMission());
    mockGetActiveRun.mockResolvedValueOnce(null);
    mockGetActiveRunBySession.mockResolvedValueOnce(null);

    const outcome = await renewMission({
      sessionId: "session-1",
      previousMissionId: "mission-source",
    });

    expect(outcome.outcome).toBe("renewed");
    expect(mockReconcileDraftReadiness).toHaveBeenCalledTimes(1);
    const cloneArgs = mockCloneMissionAsDraft.mock.calls[0]!;
    const reconcileArgs = mockReconcileDraftReadiness.mock.calls[0]!;
    const newMissionId =
      outcome.outcome === "renewed" ? outcome.newMissionId : null;
    // Called with the NEW mission id, not the source.
    expect(reconcileArgs[0]).toBe(newMissionId);
    expect(reconcileArgs[0]).not.toBe("mission-source");
    // Same tx client the clone insert used.
    expect(reconcileArgs[1]).toBe(cloneArgs[0]);
  });

  it("acquires the session-scoped advisory lock before any precondition check", async () => {
    mockGetMissionForUpdate.mockResolvedValueOnce(null);
    await renewMission({
      sessionId: "session-1",
      previousMissionId: "mission-source",
    });
    expect(mockLockSessionForRenew).toHaveBeenCalledTimes(1);
    const args = mockLockSessionForRenew.mock.calls[0]!;
    expect(args[1]).toBe("session-1");
    // Lock acquisition happened, but the source lookup still ran and failed
    // first-precondition — proves the lock is taken up front, not gated
    // behind other checks.
    expect(mockGetMissionForUpdate).toHaveBeenCalledTimes(1);
  });

  it("returns session_has_pending_draft when the session already holds a draft/ready mission, without cloning", async () => {
    // WP-D: closes the duplicate-draft-storm race TRANSACTIONALLY (advisory
    // lock + this check, both inside renewMission's transaction) rather than
    // relying solely on the renderer/resolver suppressing the button.
    mockGetMissionForUpdate.mockResolvedValueOnce(makeMission());
    mockGetActiveRun.mockResolvedValueOnce(null);
    mockGetActiveRunBySession.mockResolvedValueOnce(null);
    mockGetPendingDraftForSession.mockResolvedValueOnce({
      id: "mission-pending-draft",
      status: "draft",
    });

    const outcome = await renewMission({
      sessionId: "session-1",
      previousMissionId: "mission-source",
    });

    expect(outcome.outcome).toBe("session_has_pending_draft");
    if (outcome.outcome === "session_has_pending_draft") {
      expect(outcome.missionId).toBe("mission-pending-draft");
    }
    expect(mockCloneMissionAsDraft).not.toHaveBeenCalled();
  });

  it("checks for a pending draft using the SAME tx client as the source-mission lock (same transaction)", async () => {
    mockGetMissionForUpdate.mockResolvedValueOnce(makeMission());
    mockGetActiveRun.mockResolvedValueOnce(null);
    mockGetActiveRunBySession.mockResolvedValueOnce(null);

    await renewMission({
      sessionId: "session-1",
      previousMissionId: "mission-source",
    });

    expect(mockGetPendingDraftForSession).toHaveBeenCalledTimes(1);
    const lockClient = mockLockSessionForRenew.mock.calls[0]![0];
    const draftCheckClient = mockGetPendingDraftForSession.mock.calls[0]![0];
    expect(draftCheckClient).toBe(lockClient);
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
