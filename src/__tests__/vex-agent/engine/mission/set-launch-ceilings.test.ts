/**
 * `setMissionLaunchCeilings` — the ONLY writer for the §C6/§C6b launch
 * ceilings.
 *
 * What these tests exist to hold:
 *   1. A write INVALIDATES acceptance. Both ceilings are contract-hash material
 *      (v5), so a ceiling edited after acceptance must send the mission back
 *      through Accept — otherwise the user's signature covers a limit they
 *      never read.
 *   2. A started mission REFUSES. Its ceilings are already frozen into
 *      `mission_runs.contract_snapshot_json`, which is what enforcement reads;
 *      a late write would change the display without changing the gate.
 *   3. A value that could never bind is refused AT THE DOOR (wrong decimals,
 *      half-written pair, non-integer amount, negative count) rather than
 *      stored and silently ignored at signing time.
 *   4. Nothing is written on any refusal path.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockGetMissionForUpdate = vi.fn();
const mockMergeConstraintLaunchCeilings = vi.fn();
const mockClearAcceptance = vi.fn();

vi.mock("@vex-agent/db/client.js", () => ({
  withTransaction: vi.fn(async (fn: (client: unknown) => unknown) => fn({})),
}));

vi.mock("@vex-agent/db/repos/missions.js", () => ({
  getMissionForUpdate: (...a: unknown[]) => mockGetMissionForUpdate(...a),
  mergeConstraintLaunchCeilings: (...a: unknown[]) =>
    mockMergeConstraintLaunchCeilings(...a),
  clearAcceptance: (...a: unknown[]) => mockClearAcceptance(...a),
}));

const { setMissionLaunchCeilings } = await import(
  "../../../../vex-agent/engine/mission/set-launch-ceilings.js"
);

const SESSION = "session-1";
const MISSION = "mission-1";

/** 0.05 ETH in wei — a plausible per-launch ceiling. */
const CEILING_WEI = "50000000000000000";

function mission(overrides: Record<string, unknown> = {}) {
  return {
    id: MISSION,
    rootSessionId: SESSION,
    status: "ready",
    acceptedContractHash: null,
    constraintsJson: {},
    ...overrides,
  };
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: SESSION,
    missionId: MISSION,
    maxLaunchValueRaw: CEILING_WEI,
    maxLaunchValueDecimals: 18,
    maxLaunchCount: 2,
    ...overrides,
  } as Parameters<typeof setMissionLaunchCeilings>[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  mockMergeConstraintLaunchCeilings.mockResolvedValue(undefined);
  mockClearAcceptance.mockResolvedValue(undefined);
});

describe("setMissionLaunchCeilings", () => {
  it("writes both ceilings for an editable mission", async () => {
    mockGetMissionForUpdate.mockResolvedValue(mission());

    const r = await setMissionLaunchCeilings(input());

    expect(r).toEqual({
      outcome: "updated",
      maxLaunchValueRaw: CEILING_WEI,
      maxLaunchValueDecimals: 18,
      maxLaunchCount: 2,
      acceptanceCleared: false,
    });
    expect(mockMergeConstraintLaunchCeilings).toHaveBeenCalledWith({}, MISSION, {
      maxLaunchValueRaw: CEILING_WEI,
      maxLaunchValueDecimals: 18,
      maxLaunchCount: 2,
    });
  });

  it("INVALIDATES a prior acceptance — the ceilings are contract-hash material", async () => {
    mockGetMissionForUpdate.mockResolvedValue(
      mission({ acceptedContractHash: "a".repeat(64) }),
    );

    const r = await setMissionLaunchCeilings(input());

    expect(r).toMatchObject({ outcome: "updated", acceptanceCleared: true });
    expect(mockClearAcceptance).toHaveBeenCalledWith({}, MISSION);
  });

  it("does not clear acceptance a mission never had", async () => {
    mockGetMissionForUpdate.mockResolvedValue(mission());
    await setMissionLaunchCeilings(input());
    expect(mockClearAcceptance).not.toHaveBeenCalled();
  });

  it("clears both ceilings when both are null — cleared is zero authority", async () => {
    mockGetMissionForUpdate.mockResolvedValue(mission());

    const r = await setMissionLaunchCeilings(
      input({ maxLaunchValueRaw: null, maxLaunchValueDecimals: null, maxLaunchCount: null }),
    );

    expect(r).toMatchObject({ outcome: "updated" });
    expect(mockMergeConstraintLaunchCeilings).toHaveBeenCalledWith({}, MISSION, {
      maxLaunchValueRaw: null,
      maxLaunchValueDecimals: null,
      maxLaunchCount: null,
    });
  });

  it("REFUSES a running mission — its run already froze its ceilings", async () => {
    mockGetMissionForUpdate.mockResolvedValue(mission({ status: "running" }));

    expect(await setMissionLaunchCeilings(input())).toEqual({
      outcome: "blocked_status",
      status: "running",
    });
    expect(mockMergeConstraintLaunchCeilings).not.toHaveBeenCalled();
  });

  it("collapses a cross-session mission to not_found (no existence leak)", async () => {
    mockGetMissionForUpdate.mockResolvedValue(
      mission({ rootSessionId: "someone-else" }),
    );

    expect(await setMissionLaunchCeilings(input())).toEqual({ outcome: "not_found" });
    expect(mockMergeConstraintLaunchCeilings).not.toHaveBeenCalled();
  });

  it("returns not_found when the mission row is missing", async () => {
    mockGetMissionForUpdate.mockResolvedValue(null);
    expect(await setMissionLaunchCeilings(input())).toEqual({ outcome: "not_found" });
  });

  describe("refuses a ceiling that could never bind — before touching the DB", () => {
    const cases: ReadonlyArray<[string, Record<string, unknown>, RegExp]> = [
      [
        "decimals other than 18 (never rescaled at enforcement)",
        { maxLaunchValueDecimals: 6 },
        /exactly 18 decimals/,
      ],
      [
        "a raw amount with no decimals",
        { maxLaunchValueDecimals: null },
        /as a pair/,
      ],
      [
        "decimals with no raw amount",
        { maxLaunchValueRaw: null },
        /as a pair/,
      ],
      [
        "a decimal point in the raw wei amount",
        { maxLaunchValueRaw: "0.05" },
        /raw non-negative integer amount in wei/,
      ],
      ["a negative count", { maxLaunchCount: -1 }, /non-negative whole number/],
      ["a fractional count", { maxLaunchCount: 1.5 }, /non-negative whole number/],
    ];

    for (const [name, overrides, reason] of cases) {
      it(name, async () => {
        mockGetMissionForUpdate.mockResolvedValue(mission());

        const r = await setMissionLaunchCeilings(input(overrides));

        expect(r.outcome).toBe("invalid");
        expect(r.outcome === "invalid" && r.reason).toMatch(reason);
        expect(mockGetMissionForUpdate).not.toHaveBeenCalled();
        expect(mockMergeConstraintLaunchCeilings).not.toHaveBeenCalled();
      });
    }
  });
});
