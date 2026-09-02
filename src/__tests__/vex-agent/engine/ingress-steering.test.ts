/**
 * `submitSteeringMessage` (A33) — the liveness-gated persist. The pinned
 * laws: a live mission run or a live agent lease gets EXACTLY ONE persisted
 * `operator_interrupt` row and `queued_live`; every parked or idle state
 * persists NOTHING and returns `no_active_turn` (the caller then submits
 * normally); no turn is ever fired from this entry.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockGetActiveRunBySession = vi.fn();
const mockGetLease = vi.fn();
const mockAddOperatorInstruction = vi.fn();
const mockAddOperatorCue = vi.fn();
const mockProcessAgentTurn = vi.fn();
const mockProcessMissionSetupTurn = vi.fn();
const mockResumeMissionRun = vi.fn();

vi.mock("@vex-agent/db/repos/loop-wake.js", () => ({
  cancelForSession: vi.fn().mockResolvedValue(0),
}));

vi.mock("@vex-agent/db/repos/mission-runs.js", () => ({
  getActiveRunBySession: (...a: unknown[]) => mockGetActiveRunBySession(...a),
}));

vi.mock("@vex-agent/db/repos/missions.js", () => ({
  getActiveMission: vi.fn().mockResolvedValue(null),
}));

vi.mock("@vex-agent/db/repos/runner-leases.js", () => ({
  getLease: (...a: unknown[]) => mockGetLease(...a),
}));

vi.mock("../../../vex-agent/engine/core/runner.js", () => ({
  processAgentTurn: (...a: unknown[]) => mockProcessAgentTurn(...a),
  processMissionSetupTurn: (...a: unknown[]) => mockProcessMissionSetupTurn(...a),
  resumeMissionRun: (...a: unknown[]) => mockResumeMissionRun(...a),
}));

// The two WRITERS are mocked; `classifyOperatorInterruptDisposition` is kept
// REAL via importActual. It is the decision these tests exist to check, and a
// stubbed classifier would let the routes assert their own answer back.
vi.mock("../../../vex-agent/engine/core/operator-instructions.js", async (importActual) => ({
  ...(await importActual<Record<string, unknown>>()),
  addOperatorInstruction: (...a: unknown[]) => mockAddOperatorInstruction(...a),
  addOperatorCue: (...a: unknown[]) => mockAddOperatorCue(...a),
}));

vi.mock("@vex-agent/engine/runtime/release-and-emit.js", () => ({
  releaseLeaseAndEmitControlState: vi.fn().mockResolvedValue(undefined),
}));

const { submitSteeringMessage } = await import("../../../vex-agent/engine/ingress.js");

const SESSION = "session-1";

/**
 * `missionRunId` is part of the fixture because the route MATCHES on it: a
 * lease held for a different run is another turn's and cannot merge this
 * message. `null` is the agent-session shape (no run row exists).
 */
function liveLease(missionRunId: string | null = null): {
  expiresAt: Date;
  missionRunId: string | null;
} {
  return { expiresAt: new Date(Date.now() + 60_000), missionRunId };
}

function expiredLease(missionRunId: string | null = null): {
  expiresAt: Date;
  missionRunId: string | null;
} {
  return { expiresAt: new Date(Date.now() - 1_000), missionRunId };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetActiveRunBySession.mockResolvedValue(null);
  mockGetLease.mockResolvedValue(null);
});

describe("submitSteeringMessage", () => {
  it("a running mission run gets exactly one persisted interrupt and queued_live - no turn fires", async () => {
    mockGetActiveRunBySession.mockResolvedValue({ id: "run-1", status: "running" });
    // A live lease for THIS run is what makes the claim `steered` provable.
    mockGetLease.mockResolvedValue(liveLease("run-1"));
    const result = await submitSteeringMessage(SESSION, "steer this");
    expect(result).toEqual({ outcome: "queued_live" });
    expect(mockAddOperatorInstruction).toHaveBeenCalledTimes(1);
    // M6 contract change: the disposition is a TYPED argument on the persist
    // call, not prose derived downstream. Steering into a live run is
    // `steered` - the loop merges it at its next batch boundary.
    expect(mockAddOperatorInstruction).toHaveBeenCalledWith(SESSION, "steer this", "steered", {
      target: "mission_run",
      runId: "run-1",
      runStatus: "running",
    });
    expect(mockProcessAgentTurn).not.toHaveBeenCalled();
    expect(mockResumeMissionRun).not.toHaveBeenCalled();
  });

  /**
   * M6 correction. This route used to persist `steered` for `paused_approval`,
   * which told the operator a run parked on a human decision would pick their
   * message up mid-turn. The row still persists - it is on the tape and will be
   * read - but the DISPOSITION is now the honest weaker one.
   */
  it("a paused_approval run persists as QUEUED, not steered - nothing is executing", async () => {
    mockGetActiveRunBySession.mockResolvedValue({ id: "run-1", status: "paused_approval" });
    mockGetLease.mockResolvedValue(liveLease("run-1"));
    const result = await submitSteeringMessage(SESSION, "steer this");
    expect(result).toEqual({ outcome: "queued_live" });
    expect(mockAddOperatorInstruction).toHaveBeenCalledTimes(1);
    expect(mockAddOperatorInstruction).toHaveBeenCalledWith(
      SESSION,
      "steer this",
      "queued_interrupt",
      { target: "mission_run", runId: "run-1", runStatus: "paused_approval" },
    );
  });

  /**
   * The other half of the same correction: `running` is a ROW STATUS, and a
   * row status with a dead lease is the crashed-runner state the restart-orphan
   * sweep reclaims. Claiming a message was steered into it would describe a
   * merge that nothing is alive to perform.
   */
  it("a running run with a DEAD lease persists as queued, not steered", async () => {
    mockGetActiveRunBySession.mockResolvedValue({ id: "run-1", status: "running" });
    mockGetLease.mockResolvedValue(expiredLease("run-1"));
    const result = await submitSteeringMessage(SESSION, "steer this");
    expect(result).toEqual({ outcome: "queued_live" });
    expect(mockAddOperatorInstruction).toHaveBeenCalledWith(
      SESSION,
      "steer this",
      "queued_interrupt",
      { target: "mission_run", runId: "run-1", runStatus: "running" },
    );
  });

  it("a running run whose live lease belongs to ANOTHER run is not this turn", async () => {
    mockGetActiveRunBySession.mockResolvedValue({ id: "run-1", status: "running" });
    mockGetLease.mockResolvedValue(liveLease("run-2"));
    await submitSteeringMessage(SESSION, "steer this");
    expect(mockAddOperatorInstruction).toHaveBeenCalledWith(
      SESSION,
      "steer this",
      "queued_interrupt",
      { target: "mission_run", runId: "run-1", runStatus: "running" },
    );
  });

  it.each(["paused_wake", "paused_error", "paused_user", "paused_plan_acceptance", "paused_user_form"])(
    "a %s run is PARKED, not live: nothing persists and the caller falls back to a normal submit",
    async (status) => {
      mockGetActiveRunBySession.mockResolvedValue({ id: "run-1", status });
      const result = await submitSteeringMessage(SESSION, "steer this");
      expect(result).toEqual({ outcome: "no_active_turn" });
      expect(mockAddOperatorInstruction).not.toHaveBeenCalled();
    },
  );

  it("an agent session with a live runner lease persists the interrupt for the batch-boundary merge", async () => {
    mockGetLease.mockResolvedValue(liveLease());
    const result = await submitSteeringMessage(SESSION, "steer this");
    expect(result).toEqual({ outcome: "queued_live" });
    expect(mockAddOperatorInstruction).toHaveBeenCalledWith(SESSION, "steer this", "steered", {
      target: "agent_turn",
    });
  });

  it("an idle agent session (no lease) persists nothing - boundary: the lease is the liveness truth", async () => {
    mockGetLease.mockResolvedValue(null);
    const result = await submitSteeringMessage(SESSION, "steer this");
    expect(result).toEqual({ outcome: "no_active_turn" });
    expect(mockAddOperatorInstruction).not.toHaveBeenCalled();
  });

  it("an EXPIRED lease is one millisecond past live and counts as idle", async () => {
    mockGetLease.mockResolvedValue(expiredLease());
    const result = await submitSteeringMessage(SESSION, "steer this");
    expect(result).toEqual({ outcome: "no_active_turn" });
    expect(mockAddOperatorInstruction).not.toHaveBeenCalled();
  });
});
