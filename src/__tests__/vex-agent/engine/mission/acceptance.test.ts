/**
 * Unit tests for `engine/mission/acceptance.ts` — `acceptContract`.
 *
 * The repo + tx helpers are mocked at the module boundary; shared setup
 * (mocks + fixtures) lives in `_acceptance-mocks.ts` so this file, plus
 * `acceptance-assert-status.test.ts` and `acceptance-legacy-v2.test.ts`
 * (the `assertAcceptedContract` split), stay under the repo's 500-line cap
 * without duplicating the mock boilerplate. We test the discriminated-union
 * outcomes returned by `acceptContract` so the IPC layer in phase 6 can map
 * them to `Result<T, VexError>` envelopes without re-running engine logic.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  mockGetMissionForUpdate,
  mockUpdateAcceptance,
  mockGetActiveRun,
  mockGetActivePlan,
  mockSetAccepted,
  fakeClientQuery,
  makeMission,
  makePlan,
} from "./_acceptance-mocks.js";

const { acceptContract } = await import(
  "../../../../vex-agent/engine/mission/acceptance.js"
);
const { computeContractHash, CONTRACT_HASH_VERSION } = await import(
  "../../../../vex-agent/engine/mission/contract-hash.js"
);
const { missionToDraft } = await import(
  "../../../../vex-agent/engine/mission/mapper.js"
);

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
        contractHashVersion: CONTRACT_HASH_VERSION,
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
      expect(outcome.contractHashVersion).toBe(CONTRACT_HASH_VERSION);
      expect(outcome.acceptedAt).toBe("2026-05-22T11:00:00.000Z");
    }

    expect(mockUpdateAcceptance).toHaveBeenCalledTimes(1);
    expect(mockUpdateAcceptance).toHaveBeenCalledWith(
      expect.anything(),
      "mission-1",
      hash,
      "host",
      CONTRACT_HASH_VERSION,
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
