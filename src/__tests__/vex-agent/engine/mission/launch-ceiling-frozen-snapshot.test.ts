/**
 * The ceilings an autonomous launch is bound by come from the EXACT provenance
 * run's frozen contract snapshot — and from nothing else.
 *
 * Why this file exists: `commit-start.ts` freezes the accepted draft into
 * `mission_runs.contract_snapshot_json` precisely because the mission row stays
 * editable afterwards. A spend gate read off the live row would let an edit made
 * WHILE the agent is spending move the limit the user accepted — the money
 * equivalent of editing a contract after signing it.
 *
 * Two fallbacks that existed here are now FORBIDDEN and pinned as such:
 *   - the live mission row (mutable mid-run), and
 *   - "the mission's active run", which is a GUESS about which run is spending.
 * A launch that cannot name the run whose contract authorizes it has no
 * authorization to point at, so it refuses.
 *
 * Identity is verified rather than assumed: the run must exist, belong to the
 * given mission, and still be live. Each fault refuses BY NAME, because one
 * generic "could not be read" would make a cross-mission run id, a replay
 * against a finished run, and a missing snapshot indistinguishable.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const getMission = vi.fn();
const getRun = vi.fn();
const getActiveRun = vi.fn();

// Both are mocked so the tests can PROVE they are never consulted — the whole
// point of the no-fallback rule.
vi.mock("@vex-agent/db/repos/missions.js", () => ({ getMission }));
vi.mock("@vex-agent/db/repos/mission-runs.js", () => ({ getRun, getActiveRun }));

const { readMissionLaunchCeilings } = await import(
  "@vex-agent/engine/mission/launch-ceiling.js"
);

/** A run row carrying the snapshot `commit-start` writes. */
function runWithFrozenDraft(
  draft: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
) {
  return {
    id: "run-1",
    missionId: "m1",
    status: "running",
    contractSnapshotJson: {
      version: 1,
      capturedAt: "2026-08-02T00:00:00.000Z",
      missionPromptContext: "# Mission",
      frozenMission: { id: "m1", draft },
    },
    ...overrides,
  };
}

const FROZEN = {
  maxLaunchValueRaw: "10000000000000000", // 0.01 ETH — what the user accepted
  maxLaunchValueDecimals: 18,
  maxLaunchCount: 2,
};

beforeEach(() => {
  getMission.mockReset();
  getRun.mockReset();
  getActiveRun.mockReset();
});

/** Nothing outside the named run may ever be consulted. */
function expectNoFallbackConsulted(): void {
  expect(getMission).not.toHaveBeenCalled();
  expect(getActiveRun).not.toHaveBeenCalled();
}

describe("readMissionLaunchCeilings — the provenance run's frozen snapshot, or a refusal", () => {
  it("reads the named run's snapshot", async () => {
    getRun.mockResolvedValue(runWithFrozenDraft(FROZEN));

    expect(await readMissionLaunchCeilings("m1", "run-1")).toEqual({
      ok: true,
      ceilings: FROZEN,
    });
    expect(getRun).toHaveBeenCalledWith("run-1");
    expectNoFallbackConsulted();
  });

  it("A MID-RUN EDIT DOES NOT MOVE THE ENFORCEMENT", async () => {
    // The mission row's ceilings were raised after the run started. The run
    // stays bound by what it froze — and the row is not even read.
    getMission.mockResolvedValue({ constraintsJson: { maxLaunchCount: 99 } });
    getRun.mockResolvedValue(runWithFrozenDraft(FROZEN));

    const read = await readMissionLaunchCeilings("m1", "run-1");

    expect(read).toEqual({ ok: true, ceilings: FROZEN });
    expectNoFallbackConsulted();
  });

  it("REFUSES when the caller cannot name the run (no active-run guess)", async () => {
    for (const runId of [null, "", "   "]) {
      const read = await readMissionLaunchCeilings("m1", runId);
      expect(read.ok).toBe(false);
      expect(read.ok === false && read.reason).toMatch(/no mission run id/);
    }
    expect(getRun).not.toHaveBeenCalled();
    expectNoFallbackConsulted();
  });

  it("REFUSES a run id that does not exist", async () => {
    getRun.mockResolvedValue(null);

    const read = await readMissionLaunchCeilings("m1", "run-gone");

    expect(read.ok).toBe(false);
    expect(read.ok === false && read.reason).toMatch(/does not exist/);
    expectNoFallbackConsulted();
  });

  it("REFUSES a run belonging to a different mission", async () => {
    getRun.mockResolvedValue(
      runWithFrozenDraft(
        { maxLaunchValueRaw: "999", maxLaunchValueDecimals: 18, maxLaunchCount: 99 },
        { missionId: "someone-elses-mission" },
      ),
    );

    const read = await readMissionLaunchCeilings("m1", "run-1");

    expect(read.ok).toBe(false);
    expect(read.ok === false && read.reason).toMatch(/different mission/);
    // The other mission's generous ceilings never surface.
    expect(JSON.stringify(read)).not.toContain("999");
  });

  it("REFUSES a terminal run — a finished contract cannot authorize spending", async () => {
    for (const status of ["completed", "failed", "stopped"]) {
      getRun.mockResolvedValue(runWithFrozenDraft(FROZEN, { status }));

      const read = await readMissionLaunchCeilings("m1", "run-1");

      expect(read.ok).toBe(false);
      expect(read.ok === false && read.reason).toContain(status);
    }
    expectNoFallbackConsulted();
  });

  // ALLOWLIST, not denylist (Codex final-arc round 5): only an ACTIVE run may
  // authorize. A paused run must stop spending at the next safe checkpoint,
  // and an unknown status string is no evidence of authority.
  it("REFUSES every paused status and an unknown literal — only running authorizes", async () => {
    for (const status of [
      "paused_approval", "paused_wake", "paused_error", "paused_user",
      "paused_plan_acceptance", "paused_user_form", "corrupted_nonsense",
    ]) {
      getRun.mockResolvedValue(runWithFrozenDraft(FROZEN, { status }));

      const read = await readMissionLaunchCeilings("m1", "run-1");

      expect(read.ok, `status "${status}" must refuse`).toBe(false);
    }
    expectNoFallbackConsulted();
  });

  it("REFUSES a run whose snapshot cannot be read — never substitutes the live row", async () => {
    for (const snapshot of [null, {}, { frozenMission: null }, { frozenMission: { draft: 7 } }]) {
      getRun.mockResolvedValue({
        id: "run-1",
        missionId: "m1",
        status: "running",
        contractSnapshotJson: snapshot,
      });

      const read = await readMissionLaunchCeilings("m1", "run-1");

      expect(read.ok).toBe(false);
      expect(read.ok === false && read.reason).toMatch(/no readable frozen contract snapshot/);
    }
    expectNoFallbackConsulted();
  });

  it("treats a half-written value pair or a malformed count in the snapshot as absent", async () => {
    // Absent is zero authority: the enforcement functions then refuse. This is
    // NOT a read failure — the snapshot is readable and says "no ceiling".
    getRun.mockResolvedValue(
      runWithFrozenDraft({ maxLaunchValueRaw: "1000", maxLaunchCount: 1.5 }),
    );

    expect(await readMissionLaunchCeilings("m1", "run-1")).toEqual({
      ok: true,
      ceilings: {
        maxLaunchValueRaw: null,
        maxLaunchValueDecimals: null,
        maxLaunchCount: null,
      },
    });
  });
});
