/**
 * Unit tests for `engine/mission/commit-start.ts`.
 *
 * Repos + tx helpers are mocked; the test exercises the atomic gate
 * + state-flip + createRun discriminated outcomes. Full DB-backed
 * integration coverage lands in phase 8.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

import type { MissionBaseline } from "../../../../vex-agent/engine/mission/baseline.js";

const mockGetMissionForUpdate = vi.fn();
const mockSetStatus = vi.fn();
const mockSetApprovedAt = vi.fn();
const mockGetActiveRun = vi.fn();
const mockCreateRun = vi.fn();
const mockGetActivePlan = vi.fn();

vi.mock("@vex-agent/db/repos/missions.js", () => ({
  getMissionForUpdate: (...a: unknown[]) => mockGetMissionForUpdate(...a),
  setStatus: (...a: unknown[]) => mockSetStatus(...a),
  setApprovedAt: (...a: unknown[]) => mockSetApprovedAt(...a),
}));

vi.mock("@vex-agent/db/repos/mission-runs.js", () => ({
  getActiveRun: (...a: unknown[]) => mockGetActiveRun(...a),
  createRun: (...a: unknown[]) => mockCreateRun(...a),
}));

// Plan-acceptance start-gate (Stage 6) reads `session-plans`. Mocking the repo
// at its boundary — same style as missions / mission-runs — gives precise
// control. Default (no plan row → null) keeps the contract-only start path
// unchanged.
vi.mock("@vex-agent/db/repos/session-plans.js", () => ({
  getActivePlan: (...a: unknown[]) => mockGetActivePlan(...a),
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
  // The pre-lock session-id read: `commitMissionStart` takes the SESSION
  // CONTROL LOCK first (canonical order), which needs the session identity
  // before the missions row can be locked. `root_session_id` is immutable, so
  // the unlocked read is safe; the authoritative locked read follows.
  queryOneWith: vi.fn().mockImplementation(async (_client: unknown, sql: string) =>
    typeof sql === "string" && sql.includes("root_session_id")
      ? { root_session_id: "session-1" }
      : null,
  ),
}));

const mockGateOnOperatorStop = vi.fn().mockResolvedValue({ kind: "clear" });
vi.mock("@vex-agent/engine/runtime/lease-and-status.js", () => ({
  acquireSessionControlLock: vi.fn().mockResolvedValue(undefined),
  // Run CREATION consults the session-scoped operator-stop gate under that
  // lock, so a Stop that committed first refuses the start instead of creating
  // a run the Stop could never reach. `clear` for the cases below; the refusal
  // is pinned in `integration/engine/mission-start-stop-first.int.test.ts`.
  gateOnOperatorStopWithClient: (...a: unknown[]) =>
    mockGateOnOperatorStop(...a),
}));

const { commitMissionStart } = await import(
  "../../../../vex-agent/engine/mission/commit-start.js"
);
const { computeContractHash, CONTRACT_HASH_VERSION, LEGACY_V2_CONTRACT_HASH_VERSION } = await import(
  "../../../../vex-agent/engine/mission/contract-hash.js"
);
const { extractLegacyHyperliquidRiskV2, missionToDraft } = await import(
  "../../../../vex-agent/engine/mission/mapper.js"
);

function makeMission(overrides: Record<string, unknown> = {}) {
  // A complete + accepted mission. Tests override fields to exercise
  // each rejection branch.
  const base = {
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
    acceptedContractHash: null as string | null,
    acceptedContractAt: null as string | null,
    acceptedContractBy: null as string | null,
    contractHashVersion: null as number | null,
    renewedFromMissionId: null,
    ...overrides,
  };
  return base;
}

function makeAcceptedMission(overrides: Record<string, unknown> = {}) {
  const base = makeMission(overrides);
  const hash = computeContractHash(missionToDraft(base));
  return {
    ...base,
    acceptedContractHash: hash,
    acceptedContractAt: "2026-05-22T11:00:00.000Z",
    acceptedContractBy: "host",
    contractHashVersion: CONTRACT_HASH_VERSION,
  };
}

function makePlan(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: "session-1",
    enabled: true,
    planMd: "# Action plan",
    acceptedAt: null as string | null,
    accepted: false,
    offNoticePending: false,
    createdAt: "2026-05-22T09:00:00.000Z",
    updatedAt: "2026-05-22T09:30:00.000Z",
    ...overrides,
  };
}

/**
 * A minimal recorded baseline. `commitMissionStart` treats it as OPAQUE data
 * measured by the caller before the transaction: this test asserts it reaches
 * `createRun` unchanged, not what it contains.
 */
const BASELINE: MissionBaseline = {
  version: 1,
  capturedAt: "2026-08-10T13:12:04.000Z",
  status: "recorded",
  reasons: [],
  source: "proj_balances",
  scope: { addresses: ["0xA"] },
  portfolio: {
    totalUsdEstimate: 32.1,
    pricedRowCount: 2,
    unpricedRowCount: 0,
    oldestSyncedAt: null,
    newestSyncedAt: "2026-08-10T13:12:04.000Z",
  },
  deployedCapitalAtStart: null,
};

describe("commitMissionStart", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fakeClientQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    // Default: no plan row → the plan start-gate is skipped (plan-mode off /
    // no enabled plan), so the contract-only start path is unchanged.
    mockGetActivePlan.mockResolvedValue(null);
  });

  it("returns mission_not_found when the row is missing", async () => {
    mockGetMissionForUpdate.mockResolvedValueOnce(null);
    const outcome = await commitMissionStart({
      missionId: "missing",
      runId: "run-1",
      baseline: BASELINE,
    });
    expect(outcome.outcome).toBe("mission_not_found");
    expect(mockSetStatus).not.toHaveBeenCalled();
    expect(mockCreateRun).not.toHaveBeenCalled();
  });

  it("returns not_accepted when acceptance four-tuple is absent", async () => {
    mockGetMissionForUpdate.mockResolvedValueOnce(makeMission());
    const outcome = await commitMissionStart({
      missionId: "mission-1",
      runId: "run-1",
      baseline: BASELINE,
    });
    expect(outcome.outcome).toBe("not_accepted");
    expect(mockCreateRun).not.toHaveBeenCalled();
  });

  it("returns not_accepted when contractHashVersion mismatches the current literal", async () => {
    const mission = makeAcceptedMission();
    mockGetMissionForUpdate.mockResolvedValueOnce({
      ...mission,
      contractHashVersion: 99, // unknown recorded contract version
    });
    const outcome = await commitMissionStart({
      missionId: "mission-1",
      runId: "run-1",
      baseline: BASELINE,
    });
    expect(outcome.outcome).toBe("not_accepted");
  });

  it("returns stale_acceptance when the locked hash drifted", async () => {
    const mission = makeAcceptedMission();
    mockGetMissionForUpdate.mockResolvedValueOnce({
      ...mission,
      acceptedContractHash: "0".repeat(64),
    });
    const outcome = await commitMissionStart({
      missionId: "mission-1",
      runId: "run-1",
      baseline: BASELINE,
    });
    expect(outcome.outcome).toBe("stale_acceptance");
    if (outcome.outcome === "stale_acceptance") {
      expect(outcome.acceptedHash).toBe("0".repeat(64));
      expect(outcome.currentHash).toBe(computeContractHash(missionToDraft(mission)));
    }
    expect(mockCreateRun).not.toHaveBeenCalled();
  });

  it("returns not_ready when the locked draft is incomplete", async () => {
    const mission = makeAcceptedMission({ goal: null, title: null });
    mockGetMissionForUpdate.mockResolvedValueOnce({
      ...mission,
      acceptedContractHash: computeContractHash(missionToDraft(mission)),
    });
    const outcome = await commitMissionStart({
      missionId: "mission-1",
      runId: "run-1",
      baseline: BASELINE,
    });
    expect(outcome.outcome).toBe("not_ready");
    if (outcome.outcome === "not_ready") {
      expect(outcome.missingFields).toContain("goal");
      expect(outcome.missingFields).toContain("title");
    }
    expect(mockCreateRun).not.toHaveBeenCalled();
  });

  it("returns active_run_exists when a run is already live", async () => {
    mockGetMissionForUpdate.mockResolvedValueOnce(makeAcceptedMission());
    mockGetActiveRun.mockResolvedValueOnce({
      id: "run-existing",
      status: "running",
    });
    const outcome = await commitMissionStart({
      missionId: "mission-1",
      runId: "run-1",
      baseline: BASELINE,
    });
    expect(outcome.outcome).toBe("active_run_exists");
    if (outcome.outcome === "active_run_exists") {
      expect(outcome.missionRunId).toBe("run-existing");
    }
    expect(mockSetStatus).not.toHaveBeenCalled();
    expect(mockCreateRun).not.toHaveBeenCalled();
  });

  it("flips status → running, sets approved_at, creates run on the happy path", async () => {
    const mission = makeAcceptedMission();
    mockGetMissionForUpdate.mockResolvedValueOnce(mission);
    mockGetActiveRun.mockResolvedValueOnce(null);

    const outcome = await commitMissionStart({
      missionId: "mission-1",
      runId: "run-1",
      baseline: BASELINE,
    });

    expect(outcome.outcome).toBe("committed");
    if (outcome.outcome === "committed") {
      expect(outcome.runId).toBe("run-1");
      expect(outcome.mission.id).toBe("mission-1");
      expect(outcome.contractSnapshot.version).toBe(1);
    }
    // Every mutator receives the tx client (5th / 3rd arg) so the
    // writes ride the same lock as the SELECT FOR UPDATE that
    // opened the tx — the locked-row invariant codex required.
    expect(mockSetStatus).toHaveBeenCalledWith("mission-1", "running", expect.anything());
    expect(mockSetStatus.mock.calls[0]![2]).toBeDefined();
    expect(mockSetApprovedAt).toHaveBeenCalledWith("mission-1", expect.anything());
    expect(mockSetApprovedAt.mock.calls[0]![1]).toBeDefined();
    expect(mockCreateRun).toHaveBeenCalledTimes(1);
    const createArgs = mockCreateRun.mock.calls[0]!;
    expect(createArgs[0]).toBe("run-1");
    expect(createArgs[1]).toBe("mission-1");
    expect(createArgs[2]).toBe("session-1");
    // 4th arg = options object; 5th arg = tx client.
    expect(createArgs[4]).toBeDefined();
    expect(typeof createArgs[4]).toBe("object");
    // The baseline the caller measured at the pre-commit seam rides the SAME
    // transaction as the run row, as pure data. This transaction does no
    // fallible IO of its own to obtain it.
    expect((createArgs[3] as { baselineJson: unknown }).baselineJson).toBe(BASELINE);
  });

  // Agent Scan Phase 3 (Hyperliquid removal): a mission accepted while
  // `CONTRACT_HASH_VERSION` was 2 must still be startable — the frozen v2
  // legacy material (`contract-hash-legacy-v2.ts`) reproduces its exact
  // original hash from the raw `constraints_json.hyperliquidRisk` this
  // mission still carries, even though `MissionDraft` no longer surfaces it.
  it("commits a mission accepted under the frozen legacy v2 contract hash (historical Hyperliquid risk)", async () => {
    const hyperliquidRisk = { leverageCap: 3, perOrderNotionalPct: 20, totalNotionalPct: 100 };
    const mission = makeMission({
      constraintsJson: { deadline: "2026-04-04", hyperliquidRisk },
    });
    const legacyHash = computeContractHash(
      missionToDraft(mission),
      LEGACY_V2_CONTRACT_HASH_VERSION,
      extractLegacyHyperliquidRiskV2(mission),
    );
    const acceptedMission = {
      ...mission,
      acceptedContractHash: legacyHash,
      acceptedContractAt: "2026-05-22T11:00:00.000Z",
      acceptedContractBy: "host",
      contractHashVersion: LEGACY_V2_CONTRACT_HASH_VERSION,
    };
    mockGetMissionForUpdate.mockResolvedValueOnce(acceptedMission);
    mockGetActiveRun.mockResolvedValueOnce(null);

    const outcome = await commitMissionStart({ missionId: "mission-1", runId: "run-1", baseline: BASELINE });

    expect(outcome.outcome).toBe("committed");
    if (outcome.outcome === "committed") {
      expect(outcome.runId).toBe("run-1");
    }
    expect(mockCreateRun).toHaveBeenCalledTimes(1);
  });

  it("opens and closes a single tx (BEGIN + COMMIT)", async () => {
    mockGetMissionForUpdate.mockResolvedValueOnce(makeAcceptedMission());
    mockGetActiveRun.mockResolvedValueOnce(null);
    await commitMissionStart({ missionId: "mission-1", runId: "run-1", baseline: BASELINE });
    const sqlCalls = fakeClientQuery.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(sqlCalls).toContain("BEGIN");
    expect(sqlCalls).toContain("COMMIT");
    // No ROLLBACK on the happy path.
    expect(sqlCalls).not.toContain("ROLLBACK");
  });

  it("rolls back the tx if any step throws (no createRun leak)", async () => {
    const mission = makeAcceptedMission();
    mockGetMissionForUpdate.mockResolvedValueOnce(mission);
    mockGetActiveRun.mockResolvedValueOnce(null);
    mockSetStatus.mockRejectedValueOnce(new Error("simulated flip failure"));

    await expect(
      commitMissionStart({ missionId: "mission-1", runId: "run-1", baseline: BASELINE }),
    ).rejects.toThrow("simulated flip failure");

    expect(mockCreateRun).not.toHaveBeenCalled();
    const sqlCalls = fakeClientQuery.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(sqlCalls).toContain("ROLLBACK");
  });

  // ── Stage 6: plan-acceptance start-gate (fail closed) ──────────────────

  // Plan-mode ON + plan enabled but UNACCEPTED → fail closed with
  // plan_not_accepted (a plan_write / setEnabled re-armed the gate between the
  // unified Accept step and Start). The run must NOT start (no flip, no
  // createRun) — otherwise it would start and immediately pause on the runtime
  // gate, the exact failure this gate removes.
  it("returns plan_not_accepted when plan-mode on + plan enabled+unaccepted", async () => {
    mockGetMissionForUpdate.mockResolvedValueOnce(makeAcceptedMission());
    mockGetActivePlan.mockResolvedValue(makePlan({ enabled: true, accepted: false }));

    const outcome = await commitMissionStart({
      missionId: "mission-1",
      runId: "run-1",
      baseline: BASELINE,
    });

    expect(outcome.outcome).toBe("plan_not_accepted");
    if (outcome.outcome === "plan_not_accepted") {
      expect(outcome.missionId).toBe("mission-1");
    }
    // Gate is fail-closed BEFORE the status flip / run create.
    expect(mockSetStatus).not.toHaveBeenCalled();
    expect(mockCreateRun).not.toHaveBeenCalled();
    // The gate reads the plan via the mission's root session id.
    expect(mockGetActivePlan).toHaveBeenCalledWith("session-1", expect.anything());
  });

  // An enabled-but-EMPTY plan is also "not ready" (no planMd.length condition —
  // matches the runtime gate). Still plan_not_accepted.
  it("returns plan_not_accepted when plan enabled+unaccepted with empty body", async () => {
    mockGetMissionForUpdate.mockResolvedValueOnce(makeAcceptedMission());
    mockGetActivePlan.mockResolvedValue(makePlan({ enabled: true, accepted: false, planMd: "" }));

    const outcome = await commitMissionStart({
      missionId: "mission-1",
      runId: "run-1",
      baseline: BASELINE,
    });

    expect(outcome.outcome).toBe("plan_not_accepted");
    expect(mockCreateRun).not.toHaveBeenCalled();
  });

  // Plan-mode ON + plan ACCEPTED → the gate is satisfied; start commits
  // normally (status flip + createRun on the happy path).
  it("commits when plan-mode on + plan accepted", async () => {
    mockGetMissionForUpdate.mockResolvedValueOnce(makeAcceptedMission());
    mockGetActiveRun.mockResolvedValueOnce(null);
    mockGetActivePlan.mockResolvedValue(
      makePlan({ enabled: true, accepted: true, acceptedAt: "2026-05-22T11:00:00.000Z" }),
    );

    const outcome = await commitMissionStart({
      missionId: "mission-1",
      runId: "run-1",
      baseline: BASELINE,
    });

    expect(outcome.outcome).toBe("committed");
    expect(mockSetStatus).toHaveBeenCalledWith("mission-1", "running", expect.anything());
    expect(mockCreateRun).toHaveBeenCalledTimes(1);
  });

  // Plan-mode OFF (plan row exists but disabled) → gate skipped; commits.
  it("commits when a plan row exists but is disabled (plan-mode off)", async () => {
    mockGetMissionForUpdate.mockResolvedValueOnce(makeAcceptedMission());
    mockGetActiveRun.mockResolvedValueOnce(null);
    mockGetActivePlan.mockResolvedValue(makePlan({ enabled: false, accepted: false }));

    const outcome = await commitMissionStart({
      missionId: "mission-1",
      runId: "run-1",
      baseline: BASELINE,
    });

    expect(outcome.outcome).toBe("committed");
    expect(mockCreateRun).toHaveBeenCalledTimes(1);
  });

  // No plan row at all (default) → gate skipped; commits. Pins the byte-for-byte
  // unchanged contract-only start path.
  it("commits when there is no plan row (no plan-mode)", async () => {
    mockGetMissionForUpdate.mockResolvedValueOnce(makeAcceptedMission());
    mockGetActiveRun.mockResolvedValueOnce(null);
    mockGetActivePlan.mockResolvedValue(null);

    const outcome = await commitMissionStart({
      missionId: "mission-1",
      runId: "run-1",
      baseline: BASELINE,
    });

    expect(outcome.outcome).toBe("committed");
    expect(mockCreateRun).toHaveBeenCalledTimes(1);
  });
});
