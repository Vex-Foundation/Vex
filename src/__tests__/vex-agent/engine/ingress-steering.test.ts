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

vi.mock("../../../vex-agent/engine/core/operator-instructions.js", () => ({
  addOperatorInstruction: (...a: unknown[]) => mockAddOperatorInstruction(...a),
  addOperatorCue: (...a: unknown[]) => mockAddOperatorCue(...a),
}));

vi.mock("@vex-agent/engine/runtime/release-and-emit.js", () => ({
  releaseLeaseAndEmitControlState: vi.fn().mockResolvedValue(undefined),
}));

const { submitSteeringMessage } = await import("../../../vex-agent/engine/ingress.js");

const SESSION = "session-1";

function liveLease(): { expiresAt: Date } {
  return { expiresAt: new Date(Date.now() + 60_000) };
}

function expiredLease(): { expiresAt: Date } {
  return { expiresAt: new Date(Date.now() - 1_000) };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetActiveRunBySession.mockResolvedValue(null);
  mockGetLease.mockResolvedValue(null);
});

describe("submitSteeringMessage", () => {
  it("a running mission run gets exactly one persisted interrupt and queued_live - no turn fires", async () => {
    mockGetActiveRunBySession.mockResolvedValue({ id: "run-1", status: "running" });
    const result = await submitSteeringMessage(SESSION, "steer this");
    expect(result).toEqual({ outcome: "queued_live" });
    expect(mockAddOperatorInstruction).toHaveBeenCalledTimes(1);
    expect(mockAddOperatorInstruction).toHaveBeenCalledWith(SESSION, "steer this", {
      target: "mission_run",
      runId: "run-1",
      runStatus: "running",
    });
    expect(mockProcessAgentTurn).not.toHaveBeenCalled();
    expect(mockResumeMissionRun).not.toHaveBeenCalled();
  });

  it("a paused_approval run steers too - the loop resumes through the approval flow, not this entry", async () => {
    mockGetActiveRunBySession.mockResolvedValue({ id: "run-1", status: "paused_approval" });
    const result = await submitSteeringMessage(SESSION, "steer this");
    expect(result).toEqual({ outcome: "queued_live" });
    expect(mockAddOperatorInstruction).toHaveBeenCalledTimes(1);
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
    expect(mockAddOperatorInstruction).toHaveBeenCalledWith(SESSION, "steer this", {
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
