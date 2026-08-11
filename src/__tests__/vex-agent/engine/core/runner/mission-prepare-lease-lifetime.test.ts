/**
 * `prepareMissionStart` — the claimed lease has ONE owner at every instant.
 *
 * `createLeaseHandle` arms a renewing heartbeat interval. From that line
 * onward, any path that leaves the function without either releasing the
 * handle or handing it to a caller who will leaves that interval renewing the
 * lease FOREVER: the row never expires, so the session is blocked for as long
 * as the process lives, and no TTL sweep can recover it. That is strictly
 * worse than a lease that merely lapses.
 *
 * The refusal paths already released. What did not was a THROW: two fallible
 * reads (the post-claim race re-check and the session permission read) and the
 * commit sat outside any lifetime guard. A DB blip in either read leaked the
 * heartbeat. These tests drive a throw through each one and assert the release.
 *
 * Same defect class as the operator-stop continuation leak; the fix is the
 * same shape — one ownership-transfer `try/finally`, released unless the
 * prepared continuation successfully takes ownership.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockGetMission = vi.fn();
const mockGetActiveRunBySession = vi.fn();
const mockResolveProvider = vi.fn();
const mockClaimSessionLease = vi.fn();
const mockGetSession = vi.fn();
const mockCommitMissionStart = vi.fn();
const mockBuildMissionBaseline = vi.fn();
const mockRelease = vi.fn();
const mockReleaseLeaseAndEmitControlState = vi.fn();
const mockStopHeartbeat = vi.fn();

vi.mock("@vex-agent/db/repos/missions.js", () => ({
  getMission: (...a: unknown[]) => mockGetMission(...a),
  getMissionForUpdate: vi.fn(),
}));

vi.mock("@vex-agent/db/repos/mission-runs.js", () => ({
  getActiveRunBySession: (...a: unknown[]) => mockGetActiveRunBySession(...a),
}));

vi.mock("@vex-agent/db/repos/sessions.js", () => ({
  getSession: (...a: unknown[]) => mockGetSession(...a),
}));

vi.mock("@vex-agent/inference/registry.js", () => ({
  resolveProvider: (...a: unknown[]) => mockResolveProvider(...a),
}));

vi.mock("../../../../../vex-agent/engine/mission/commit-start.js", () => ({
  commitMissionStart: (...a: unknown[]) => mockCommitMissionStart(...a),
}));

/**
 * The baseline builder is now on the tested path. Its own contract is that it
 * NEVER rejects; the mock exists so this suite can violate that contract on
 * purpose and prove the seam holds anyway.
 */
vi.mock("../../../../../vex-agent/engine/mission/baseline.js", () => ({
  buildMissionBaseline: (...a: unknown[]) => mockBuildMissionBaseline(...a),
  absentBaseline: (reason: string) => ({
    version: 1,
    capturedAt: "2026-08-10T00:00:00.000Z",
    status: "absent",
    reasons: [reason],
    source: "proj_balances",
    scope: { addresses: [] },
    portfolio: null,
    deployedCapitalAtStart: null,
  }),
}));

vi.mock("../../../../../vex-agent/engine/runtime/lease-and-status.js", () => ({
  claimSessionLease: (...a: unknown[]) => mockClaimSessionLease(...a),
  LEASE_TTL_MS: 300_000,
}));

/**
 * The handle stands in for the real one, including the property that makes
 * this bug expensive: `release()` is the ONLY thing that stops the heartbeat.
 */
vi.mock("../../../../../vex-agent/engine/runtime/lease-handle.js", () => ({
  createLeaseHandle: () => ({
    lease: { sessionId: "session-1" },
    ownerId: "owner-1",
    release: async () => {
      mockStopHeartbeat();
      mockRelease();
    },
  }),
}));

vi.mock("../../../../../vex-agent/engine/runtime/release-and-emit.js", () => ({
  releaseLeaseAndEmitControlState: async (handle: { release: () => Promise<void> }) => {
    mockReleaseLeaseAndEmitControlState();
    await handle.release();
  },
}));

vi.mock("@utils/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { prepareMissionStart } = await import(
  "../../../../../vex-agent/engine/core/runner/mission-prepare.js"
);

const SESSION = "session-1";
const MISSION = "mission-1";

beforeEach(() => {
  vi.clearAllMocks();
  mockGetMission.mockResolvedValue({ id: MISSION, rootSessionId: SESSION });
  mockGetActiveRunBySession.mockResolvedValue(null);
  mockResolveProvider.mockResolvedValue({
    loadConfig: async () => ({ model: "m", contextLimit: 131_072 }),
  });
  mockClaimSessionLease.mockResolvedValue({
    outcome: "claimed",
    lease: { sessionId: SESSION },
  });
  mockGetSession.mockResolvedValue({ permission: "restricted" });
  mockBuildMissionBaseline.mockResolvedValue({
    version: 1,
    capturedAt: "2026-08-10T00:00:00.000Z",
    status: "recorded",
    reasons: [],
    source: "proj_balances",
    scope: { addresses: [] },
    portfolio: {
      totalUsdEstimate: 1,
      pricedRowCount: 1,
      unpricedRowCount: 0,
      oldestSyncedAt: null,
      newestSyncedAt: null,
    },
    deployedCapitalAtStart: null,
  });
  mockCommitMissionStart.mockResolvedValue({
    outcome: "committed",
    mission: { id: MISSION },
    runId: "run-1",
    contractSnapshot: {},
  });
});

describe("prepareMissionStart lease lifetime", () => {
  it("hands the live handle to the caller on the prepared path", async () => {
    const outcome = await prepareMissionStart({ missionId: MISSION });

    expect(outcome.outcome).toBe("prepared");
    // Ownership TRANSFERS — the continuation releases it when the run ends.
    expect(mockRelease).not.toHaveBeenCalled();
  });

  it("releases the heartbeat when the post-claim race re-check THROWS", async () => {
    // First call (pre-claim gate) succeeds; the post-claim re-check blows up.
    mockGetActiveRunBySession
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error("db connection reset"));

    await expect(prepareMissionStart({ missionId: MISSION })).rejects.toThrow(
      "db connection reset",
    );

    expect(mockStopHeartbeat).toHaveBeenCalledTimes(1);
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  it("releases the heartbeat when the session permission read THROWS", async () => {
    mockGetSession.mockRejectedValueOnce(new Error("db connection reset"));

    await expect(prepareMissionStart({ missionId: MISSION })).rejects.toThrow(
      "db connection reset",
    );

    expect(mockStopHeartbeat).toHaveBeenCalledTimes(1);
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  it("releases the heartbeat when the commit THROWS", async () => {
    mockCommitMissionStart.mockRejectedValueOnce(new Error("tx deadlock"));

    await expect(prepareMissionStart({ missionId: MISSION })).rejects.toThrow(
      "tx deadlock",
    );

    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  it("still releases on the ordinary refusal outcomes", async () => {
    mockGetSession.mockResolvedValueOnce(null);

    const outcome = await prepareMissionStart({ missionId: MISSION });

    expect(outcome.outcome).toBe("session_not_found");
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  /**
   * FAIL-OPEN, proven at the seam rather than inside the module. A balance read
   * is measurement, not authorization: it must never be able to refuse a
   * mission the user asked to start, and it must never leak the lease on its
   * way out. This holds even if `buildMissionBaseline`'s own no-throw guarantee
   * regresses.
   */
  it("still starts the mission and never leaks the lease when the baseline builder REJECTS", async () => {
    mockBuildMissionBaseline.mockRejectedValueOnce(new Error("valuation blew up"));

    const outcome = await prepareMissionStart({ missionId: MISSION });

    expect(outcome.outcome).toBe("prepared");
    expect(mockCommitMissionStart).toHaveBeenCalledTimes(1);
    // An absent baseline with a NAMED reason is still committed with the run:
    // a NULL column would be indistinguishable from a pre-migration run.
    expect(mockCommitMissionStart).toHaveBeenCalledWith(
      expect.objectContaining({
        missionId: MISSION,
        baseline: expect.objectContaining({
          status: "absent",
          reasons: ["valuation_failed"],
        }),
      }),
    );
    // Ownership TRANSFERS on the prepared path; nothing was leaked or released.
    expect(mockRelease).not.toHaveBeenCalled();
    expect(mockStopHeartbeat).not.toHaveBeenCalled();
  });

  it("releases exactly once — never double-released on a refusal", async () => {
    mockCommitMissionStart.mockResolvedValueOnce({
      outcome: "not_ready",
      missingFields: ["goal"],
    });

    const outcome = await prepareMissionStart({ missionId: MISSION });

    expect(outcome.outcome).toBe("not_ready");
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });
});
