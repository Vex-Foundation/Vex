/**
 * Unit tests for `engine/mission/acceptance.ts`.
 *
 * The repo + tx helpers are mocked at the module boundary. We test the
 * discriminated-union outcomes returned by `acceptContract` so the IPC
 * layer in phase 6 can map them to `Result<T, VexError>` envelopes
 * without re-running engine logic.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockGetMissionForUpdate = vi.fn();
const mockUpdateAcceptance = vi.fn();
const mockGetActiveRun = vi.fn();
const mockGetActivePlan = vi.fn();
const mockSetAccepted = vi.fn();

vi.mock("@vex-agent/db/repos/missions.js", () => ({
  getMissionForUpdate: (...args: unknown[]) => mockGetMissionForUpdate(...args),
  updateAcceptance: (...args: unknown[]) => mockUpdateAcceptance(...args),
}));

vi.mock("@vex-agent/db/repos/mission-runs.js", () => ({
  getActiveRun: (...args: unknown[]) => mockGetActiveRun(...args),
}));

// Co-accept (Approach A) reaches `session-plans` for the enabled+unaccepted
// branch. Mocking the repo at its module boundary — same style as the missions
// / mission-runs repos above — gives precise control over `getActivePlan` and
// `setAccepted` per case. The default (no plan row) returns null so the existing
// contract-only outcomes behave byte-for-byte as before.
vi.mock("@vex-agent/db/repos/session-plans.js", () => ({
  getActivePlan: (...args: unknown[]) => mockGetActivePlan(...args),
  setAccepted: (...args: unknown[]) => mockSetAccepted(...args),
}));

// `withTransaction` is exercised for real — it just calls the fn with a
// fake client object and runs BEGIN/COMMIT against it. We mock the pool
// so the BEGIN/COMMIT noop doesn't error.
const fakeClientQuery = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
const fakeClientRelease = vi.fn();

vi.mock("@vex-agent/db/client.js", () => ({
  getPool: () => ({
    connect: async () => ({
      query: fakeClientQuery,
      release: fakeClientRelease,
    }),
  }),
  // Keep `withTransaction` real so the BEGIN/COMMIT contract is exercised.
  withTransaction: async (fn: (client: unknown) => Promise<unknown>) => {
    const fakeClient = { query: fakeClientQuery, release: fakeClientRelease };
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
  // The session-plans repo (co-accept path) is mocked above, so these tx-aware
  // query helpers are not reached today. Exported anyway — mirroring
  // commit-start.test.ts — so the mock stays complete if a future repo call
  // routes through them, instead of throwing "No export defined".
  executeWith: vi.fn(),
  queryOneWith: vi.fn().mockResolvedValue(null),
}));

const { acceptContract, assertAcceptedContract } = await import(
  "../../../../vex-agent/engine/mission/acceptance.js"
);
const { computeContractHash } = await import(
  "../../../../vex-agent/engine/mission/contract-hash.js"
);
const { missionToDraft } = await import(
  "../../../../vex-agent/engine/mission/mapper.js"
);

function makeMission(overrides: Record<string, unknown> = {}) {
  return {
    id: "mission-1",
    rootSessionId: "session-1",
    status: "ready",
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
    approvedAt: null,
    acceptedContractHash: null,
    acceptedContractAt: null,
    acceptedContractBy: null,
    contractHashVersion: null,
    renewedFromMissionId: null,
    ...overrides,
  };
}

/**
 * A mapped `SessionPlan` (the repo's domain shape). Plan-mode OFF / no plan is
 * the default in `beforeEach` (getActivePlan → null); these fixtures cover the
 * enabled branches.
 */
function makePlan(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: "session-1",
    enabled: true,
    planMd: "# Action plan\n1. Objective",
    acceptedAt: null as string | null,
    accepted: false,
    offNoticePending: false,
    createdAt: "2026-05-22T09:00:00.000Z",
    updatedAt: "2026-05-22T09:30:00.000Z",
    ...overrides,
  };
}

describe("acceptContract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fakeClientQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    // Default: no plan row → the co-accept branch is skipped, so the contract
    // outcomes below behave byte-for-byte as before plan-mode existed.
    mockGetActivePlan.mockResolvedValue(null);
  });

  it("returns mission_not_found when row is missing", async () => {
    mockGetMissionForUpdate.mockResolvedValueOnce(null);
    const outcome = await acceptContract({
      sessionId: "session-1",
      missionId: "mission-1",
      contractHash: "x".repeat(64),
    });
    expect(outcome.outcome).toBe("mission_not_found");
  });

  it("returns session_mismatch when mission belongs to another session", async () => {
    mockGetMissionForUpdate.mockResolvedValueOnce(
      makeMission({ rootSessionId: "OTHER" }),
    );
    const outcome = await acceptContract({
      sessionId: "session-1",
      missionId: "mission-1",
      contractHash: "x".repeat(64),
    });
    expect(outcome.outcome).toBe("session_mismatch");
    if (outcome.outcome === "session_mismatch") {
      expect(outcome.expectedSessionId).toBe("OTHER");
    }
  });

  it("returns hash_mismatch when the UI hash doesn't match the locked row", async () => {
    const mission = makeMission();
    mockGetMissionForUpdate.mockResolvedValueOnce(mission);
    const staleHash = "0".repeat(64);
    const outcome = await acceptContract({
      sessionId: "session-1",
      missionId: "mission-1",
      contractHash: staleHash,
    });
    expect(outcome.outcome).toBe("hash_mismatch");
    if (outcome.outcome === "hash_mismatch") {
      expect(outcome.providedHash).toBe(staleHash);
      expect(outcome.currentHash).toBe(computeContractHash(missionToDraft(mission)));
    }
  });

  it("returns status_blocked when mission is running / completed / cancelled", async () => {
    const mission = makeMission({ status: "running" });
    mockGetMissionForUpdate.mockResolvedValueOnce(mission);
    const outcome = await acceptContract({
      sessionId: "session-1",
      missionId: "mission-1",
      contractHash: computeContractHash(missionToDraft(mission)),
    });
    expect(outcome.outcome).toBe("status_blocked");
    if (outcome.outcome === "status_blocked") {
      expect(outcome.currentStatus).toBe("running");
    }
  });

  it("returns run_active when a mission_run is active or paused", async () => {
    const mission = makeMission();
    mockGetMissionForUpdate.mockResolvedValueOnce(mission);
    mockGetActiveRun.mockResolvedValueOnce({
      id: "run-1",
      status: "paused_approval",
    });
    const outcome = await acceptContract({
      sessionId: "session-1",
      missionId: "mission-1",
      contractHash: computeContractHash(missionToDraft(mission)),
    });
    expect(outcome.outcome).toBe("run_active");
    if (outcome.outcome === "run_active") {
      expect(outcome.missionRunId).toBe("run-1");
      expect(outcome.runStatus).toBe("paused_approval");
    }
  });

  it("writes acceptance four-tuple and returns accepted outcome on success", async () => {
    const mission = makeMission();
    const hash = computeContractHash(missionToDraft(mission));
    mockGetMissionForUpdate
      .mockResolvedValueOnce(mission)
      .mockResolvedValueOnce(makeMission({
        acceptedContractHash: hash,
        acceptedContractAt: "2026-05-22T11:00:00.000Z",
        acceptedContractBy: "host",
        contractHashVersion: 2,
      }));
    mockGetActiveRun.mockResolvedValueOnce(null);

    const outcome = await acceptContract({
      sessionId: "session-1",
      missionId: "mission-1",
      contractHash: hash,
    });

    expect(outcome.outcome).toBe("accepted");
    if (outcome.outcome === "accepted") {
      expect(outcome.acceptedContractHash).toBe(hash);
      expect(outcome.acceptedBy).toBe("host");
      expect(outcome.contractHashVersion).toBe(2);
      expect(outcome.acceptedAt).toBe("2026-05-22T11:00:00.000Z");
    }

    expect(mockUpdateAcceptance).toHaveBeenCalledTimes(1);
    expect(mockUpdateAcceptance).toHaveBeenCalledWith(
      expect.anything(),
      "mission-1",
      hash,
      "host",
      2,
    );
  });

  it("opens and closes a transaction (BEGIN + COMMIT)", async () => {
    const mission = makeMission();
    const hash = computeContractHash(missionToDraft(mission));
    mockGetMissionForUpdate
      .mockResolvedValueOnce(mission)
      .mockResolvedValueOnce(makeMission({
        acceptedContractHash: hash,
        acceptedContractAt: "2026-05-22T11:00:00.000Z",
        acceptedContractBy: "host",
        contractHashVersion: 2,
      }));
    mockGetActiveRun.mockResolvedValueOnce(null);

    await acceptContract({
      sessionId: "session-1",
      missionId: "mission-1",
      contractHash: hash,
    });

    const sqlCalls = fakeClientQuery.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(sqlCalls).toContain("BEGIN");
    expect(sqlCalls).toContain("COMMIT");
  });

  // Phase 8 lock-order invariant: `getMissionForUpdate` (SELECT FOR
  // UPDATE) MUST run before `updateAcceptance` AND both share the
  // same tx client. A regression that drops FOR UPDATE or routes the
  // write through the pool would let concurrent acceptContract calls
  // race past each other.
  it("acquires the row lock (FOR UPDATE) before writing acceptance", async () => {
    const mission = makeMission();
    const hash = computeContractHash(missionToDraft(mission));
    mockGetMissionForUpdate
      .mockResolvedValueOnce(mission)
      .mockResolvedValueOnce(makeMission({
        acceptedContractHash: hash,
        acceptedContractAt: "2026-05-22T11:00:00.000Z",
        acceptedContractBy: "host",
        contractHashVersion: 2,
      }));
    mockGetActiveRun.mockResolvedValueOnce(null);
    await acceptContract({
      sessionId: "session-1",
      missionId: "mission-1",
      contractHash: hash,
    });

    const lockOrder = mockGetMissionForUpdate.mock.invocationCallOrder[0];
    const writeOrder = mockUpdateAcceptance.mock.invocationCallOrder[0];
    expect(lockOrder).toBeDefined();
    expect(writeOrder).toBeDefined();
    expect(lockOrder).toBeLessThan(writeOrder!);

    const lockClient = mockGetMissionForUpdate.mock.calls[0]?.[0];
    const writeClient = mockUpdateAcceptance.mock.calls[0]?.[0];
    expect(lockClient).toBeDefined();
    expect(writeClient).toBe(lockClient);
  });

  // ── Approach A: unified contract + plan acceptance (plan-mode) ──────────

  // (a) Plan-mode OFF / no enabled plan → the co-accept branch is skipped
  //     entirely; the contract-only "accepted" outcome is byte-for-byte the
  //     same as before plan-mode existed, and the plan is never touched.
  it("plan-mode OFF (no plan row) → contract-only accepted, plan untouched", async () => {
    const mission = makeMission();
    const hash = computeContractHash(missionToDraft(mission));
    mockGetMissionForUpdate
      .mockResolvedValueOnce(mission)
      .mockResolvedValueOnce(makeMission({
        acceptedContractHash: hash,
        acceptedContractAt: "2026-05-22T11:00:00.000Z",
        acceptedContractBy: "host",
        contractHashVersion: 2,
      }));
    mockGetActiveRun.mockResolvedValueOnce(null);
    mockGetActivePlan.mockResolvedValue(null); // default, made explicit

    const outcome = await acceptContract({
      sessionId: "session-1",
      missionId: "mission-1",
      contractHash: hash,
    });

    expect(outcome.outcome).toBe("accepted");
    if (outcome.outcome === "accepted") {
      // No plan co-accepted → planAcceptedAt absent.
      expect(outcome.planAcceptedAt).toBeUndefined();
    }
    expect(mockSetAccepted).not.toHaveBeenCalled();
    expect(mockUpdateAcceptance).toHaveBeenCalledTimes(1);
  });

  // Same skip when a plan row exists but is disabled or already accepted —
  // `plan?.enabled && !plan.accepted` is false → no co-accept, no setAccepted.
  it("plan exists but disabled → contract-only accepted, setAccepted not called", async () => {
    const mission = makeMission();
    const hash = computeContractHash(missionToDraft(mission));
    mockGetMissionForUpdate
      .mockResolvedValueOnce(mission)
      .mockResolvedValueOnce(makeMission({
        acceptedContractHash: hash,
        acceptedContractAt: "2026-05-22T11:00:00.000Z",
        acceptedContractBy: "host",
        contractHashVersion: 2,
      }));
    mockGetActiveRun.mockResolvedValueOnce(null);
    mockGetActivePlan.mockResolvedValue(makePlan({ enabled: false }));

    const outcome = await acceptContract({
      sessionId: "session-1",
      missionId: "mission-1",
      contractHash: hash,
      planUpdatedAt: "2026-05-22T09:30:00.000Z",
    });

    expect(outcome.outcome).toBe("accepted");
    expect(mockSetAccepted).not.toHaveBeenCalled();
  });

  // (b) Enabled + unaccepted + non-empty plan + MATCHING planUpdatedAt →
  //     contract AND plan accepted in ONE tx (single BEGIN/COMMIT). The engine
  //     accepts the locked row's OWN planMd; the returned planAcceptedAt comes
  //     from the setAccepted row.
  it("enabled+unaccepted plan + matching planUpdatedAt → both accepted in one TX", async () => {
    const mission = makeMission();
    const hash = computeContractHash(missionToDraft(mission));
    mockGetMissionForUpdate
      .mockResolvedValueOnce(mission)
      .mockResolvedValueOnce(makeMission({
        acceptedContractHash: hash,
        acceptedContractAt: "2026-05-22T11:00:00.000Z",
        acceptedContractBy: "host",
        contractHashVersion: 2,
      }));
    mockGetActiveRun.mockResolvedValueOnce(null);
    const plan = makePlan({ updatedAt: "2026-05-22T09:30:00.000Z" });
    mockGetActivePlan.mockResolvedValue(plan);
    mockSetAccepted.mockResolvedValueOnce(
      makePlan({ accepted: true, acceptedAt: "2026-05-22T11:00:00.500Z" }),
    );

    const outcome = await acceptContract({
      sessionId: "session-1",
      missionId: "mission-1",
      contractHash: hash,
      planUpdatedAt: "2026-05-22T09:30:00.000Z",
    });

    expect(outcome.outcome).toBe("accepted");
    if (outcome.outcome === "accepted") {
      expect(outcome.acceptedContractHash).toBe(hash);
      expect(outcome.planAcceptedAt).toBe("2026-05-22T11:00:00.500Z");
    }
    // The engine accepts the LOCKED row's own planMd (never renderer-supplied),
    // passing the same tx client as the row-lock read.
    expect(mockSetAccepted).toHaveBeenCalledTimes(1);
    const setArgs = mockSetAccepted.mock.calls[0]!;
    expect(setArgs[0]).toBe("session-1");
    expect(setArgs[1]).toBe(plan.planMd);
    const lockClient = mockGetMissionForUpdate.mock.calls[0]?.[0];
    expect(setArgs[2]).toBe(lockClient);
    expect(mockUpdateAcceptance).toHaveBeenCalledTimes(1);

    // One transaction, committed (both writes durable on the same COMMIT).
    const sqlCalls = fakeClientQuery.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(sqlCalls).toContain("BEGIN");
    expect(sqlCalls).toContain("COMMIT");
    expect(sqlCalls).not.toContain("ROLLBACK");
  });

  // (c1) planUpdatedAt ABSENT (enabled+unaccepted+non-empty) → plan_stale, and
  //      the whole TX rolls back: the contract four-tuple write
  //      (`updateAcceptance`) never ran and the tx ROLLED BACK (not committed).
  it("enabled plan + ABSENT planUpdatedAt → plan_stale + rollback (contract NOT accepted)", async () => {
    const mission = makeMission();
    const hash = computeContractHash(missionToDraft(mission));
    mockGetMissionForUpdate.mockResolvedValueOnce(mission);
    mockGetActiveRun.mockResolvedValueOnce(null);
    mockGetActivePlan.mockResolvedValue(makePlan({ updatedAt: "2026-05-22T09:30:00.000Z" }));

    const outcome = await acceptContract({
      sessionId: "session-1",
      missionId: "mission-1",
      contractHash: hash,
      // planUpdatedAt omitted → the reviewed-plan guard cannot match.
    });

    expect(outcome.outcome).toBe("plan_stale");
    // Rollback proof: the contract four-tuple write never executed, setAccepted
    // never ran, and the tx ROLLED BACK rather than committing.
    expect(mockSetAccepted).not.toHaveBeenCalled();
    expect(mockUpdateAcceptance).not.toHaveBeenCalled();
    const sqlCalls = fakeClientQuery.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(sqlCalls).toContain("ROLLBACK");
    expect(sqlCalls).not.toContain("COMMIT");
  });

  // (c2) planUpdatedAt MISMATCHED → same plan_stale + rollback.
  it("enabled plan + MISMATCHED planUpdatedAt → plan_stale + rollback", async () => {
    const mission = makeMission();
    const hash = computeContractHash(missionToDraft(mission));
    mockGetMissionForUpdate.mockResolvedValueOnce(mission);
    mockGetActiveRun.mockResolvedValueOnce(null);
    mockGetActivePlan.mockResolvedValue(makePlan({ updatedAt: "2026-05-22T09:30:00.000Z" }));

    const outcome = await acceptContract({
      sessionId: "session-1",
      missionId: "mission-1",
      contractHash: hash,
      planUpdatedAt: "2026-05-22T08:00:00.000Z", // stale view — does not match
    });

    expect(outcome.outcome).toBe("plan_stale");
    expect(mockSetAccepted).not.toHaveBeenCalled();
    expect(mockUpdateAcceptance).not.toHaveBeenCalled();
    const sqlCalls = fakeClientQuery.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(sqlCalls).toContain("ROLLBACK");
    expect(sqlCalls).not.toContain("COMMIT");
  });

  // (d) setAccepted returns falsy (content raced under our own read) →
  //     plan_stale + rollback. The guard matched but the conditional UPDATE
  //     missed its WHERE.
  it("matching planUpdatedAt but setAccepted returns null → plan_stale + rollback", async () => {
    const mission = makeMission();
    const hash = computeContractHash(missionToDraft(mission));
    mockGetMissionForUpdate.mockResolvedValueOnce(mission);
    mockGetActiveRun.mockResolvedValueOnce(null);
    mockGetActivePlan.mockResolvedValue(makePlan({ updatedAt: "2026-05-22T09:30:00.000Z" }));
    mockSetAccepted.mockResolvedValueOnce(null); // WHERE missed → content raced

    const outcome = await acceptContract({
      sessionId: "session-1",
      missionId: "mission-1",
      contractHash: hash,
      planUpdatedAt: "2026-05-22T09:30:00.000Z",
    });

    expect(outcome.outcome).toBe("plan_stale");
    expect(mockSetAccepted).toHaveBeenCalledTimes(1);
    expect(mockUpdateAcceptance).not.toHaveBeenCalled();
    const sqlCalls = fakeClientQuery.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(sqlCalls).toContain("ROLLBACK");
    expect(sqlCalls).not.toContain("COMMIT");
  });

  // (e) Enabled + EMPTY planMd → plan_missing (nothing authored). Same
  //     `enabled && !accepted` condition as the runtime gate (no length
  //     condition), so an enabled-but-empty plan fails accept instead of
  //     slipping through. Contract NOT accepted; tx rolled back.
  it("enabled + EMPTY planMd → plan_missing + rollback (contract NOT accepted)", async () => {
    const mission = makeMission();
    const hash = computeContractHash(missionToDraft(mission));
    mockGetMissionForUpdate.mockResolvedValueOnce(mission);
    mockGetActiveRun.mockResolvedValueOnce(null);
    mockGetActivePlan.mockResolvedValue(makePlan({ planMd: "" }));

    const outcome = await acceptContract({
      sessionId: "session-1",
      missionId: "mission-1",
      contractHash: hash,
      planUpdatedAt: "2026-05-22T09:30:00.000Z",
    });

    expect(outcome.outcome).toBe("plan_missing");
    expect(mockSetAccepted).not.toHaveBeenCalled();
    expect(mockUpdateAcceptance).not.toHaveBeenCalled();
    const sqlCalls = fakeClientQuery.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(sqlCalls).toContain("ROLLBACK");
    expect(sqlCalls).not.toContain("COMMIT");
  });
});

// ── assertAcceptedContract (puzzle 04 phase 4 gate) ──────────────

describe("assertAcceptedContract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fakeClientQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  });

  it("returns mission_not_found when the row is missing", async () => {
    mockGetMissionForUpdate.mockResolvedValueOnce(null);
    const outcome = await assertAcceptedContract({ missionId: "mission-1" });
    expect(outcome.outcome).toBe("mission_not_found");
  });

  it("returns not_accepted when accepted_contract_hash is null", async () => {
    mockGetMissionForUpdate.mockResolvedValueOnce(
      makeMission({ acceptedContractHash: null, contractHashVersion: null }),
    );
    const outcome = await assertAcceptedContract({ missionId: "mission-1" });
    expect(outcome.outcome).toBe("not_accepted");
    if (outcome.outcome === "not_accepted") {
      expect(outcome.missionId).toBe("mission-1");
    }
  });

  it("returns stale_acceptance when the recomputed hash drifted", async () => {
    const mission = makeMission({
      acceptedContractHash: "0".repeat(64),
      acceptedContractAt: "2026-05-22T11:00:00.000Z",
      acceptedContractBy: "host",
      contractHashVersion: 1,
    });
    mockGetMissionForUpdate.mockResolvedValueOnce(mission);

    const outcome = await assertAcceptedContract({ missionId: "mission-1" });
    expect(outcome.outcome).toBe("stale_acceptance");
    if (outcome.outcome === "stale_acceptance") {
      expect(outcome.acceptedHash).toBe("0".repeat(64));
      expect(outcome.currentHash).toBe(computeContractHash(missionToDraft(mission), 1));
      expect(outcome.currentHash).not.toBe(outcome.acceptedHash);
    }
  });

  it("returns accepted when the four-tuple matches the current draft", async () => {
    const mission = makeMission();
    const currentHash = computeContractHash(missionToDraft(mission), 1);
    mockGetMissionForUpdate.mockResolvedValueOnce({
      ...mission,
      acceptedContractHash: currentHash,
      acceptedContractAt: "2026-05-22T11:00:00.000Z",
      acceptedContractBy: "host",
      contractHashVersion: 1,
    });

    const outcome = await assertAcceptedContract({ missionId: "mission-1" });
    expect(outcome.outcome).toBe("accepted");
    if (outcome.outcome === "accepted") {
      expect(outcome.contractHash).toBe(currentHash);
      expect(outcome.contractHashVersion).toBe(1);
    }
  });

  it("opens and closes a transaction (BEGIN + COMMIT) for the gate read", async () => {
    mockGetMissionForUpdate.mockResolvedValueOnce(
      makeMission({ acceptedContractHash: null, contractHashVersion: null }),
    );
    await assertAcceptedContract({ missionId: "mission-1" });
    const sqlCalls = fakeClientQuery.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(sqlCalls).toContain("BEGIN");
    expect(sqlCalls).toContain("COMMIT");
  });
});
