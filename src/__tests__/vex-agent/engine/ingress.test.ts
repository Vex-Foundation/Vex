/**
 * Ingress router unit tests. Covers the preempt-then-route matrix:
 *   - cancelForSession is ALWAYS called first,
 *   - paused_wake run → flip to running + save user msg + resumeMissionRun,
 *   - paused_approval / running run → persist interrupt, no new turn,
 *   - paused_error → return recovery hint + persist interrupt,
 *   - no run + active mission (draft) → processMissionSetupTurn,
 *   - no run + no mission → processAgentTurn.
 *
 * Phase 2 collapse: `full_autonomous` route is gone; agent mode is the
 * default when no mission row exists.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockCancelForSession = vi.fn();
const mockGetActiveRunBySession = vi.fn();
const mockUpdateRunStatus = vi.fn();
const mockCasFlipToRunning = vi.fn();
const mockGetSession = vi.fn();
const mockGetActiveMission = vi.fn();
const mockAddMessage = vi.fn();
const mockAddEngineMessage = vi.fn();
const mockProcessAgentTurn = vi.fn();
const mockProcessMissionSetupTurn = vi.fn();
const mockResumeMissionRun = vi.fn();
const mockAddOperatorInstruction = vi.fn();
const mockAddOperatorCue = vi.fn();

vi.mock("@vex-agent/db/repos/loop-wake.js", () => ({
  cancelForSession: (...a: unknown[]) => mockCancelForSession(...a),
}));

vi.mock("@vex-agent/db/repos/mission-runs.js", () => ({
  getActiveRunBySession: (...a: unknown[]) => mockGetActiveRunBySession(...a),
  updateStatus: (...a: unknown[]) => mockUpdateRunStatus(...a),
  casFlipToRunning: (...a: unknown[]) => mockCasFlipToRunning(...a),
}));

vi.mock("@vex-agent/db/repos/sessions.js", () => ({
  getSession: (...a: unknown[]) => mockGetSession(...a),
}));

vi.mock("@vex-agent/db/repos/missions.js", () => ({
  getActiveMission: (...a: unknown[]) => mockGetActiveMission(...a),
}));

vi.mock("@vex-agent/db/repos/messages.js", () => ({
  addMessage: (...a: unknown[]) => mockAddMessage(...a),
  addEngineMessage: (...a: unknown[]) => mockAddEngineMessage(...a),
  addMessageReturningId: vi.fn().mockResolvedValue({
    id: 1, role: "user", content: "", timestamp: new Date().toISOString(),
  }),
}));

vi.mock("@vex-agent/engine/events/index.js", () => ({
  appendMessage: (...a: unknown[]) => mockAddMessage(...a),
  appendEngineMessage: (...a: unknown[]) => mockAddEngineMessage(...a),
  emitTranscriptAppend: vi.fn(),
}));

vi.mock("@vex-agent/db/client.js", () => ({
  execute: vi.fn(),
  query: vi.fn().mockResolvedValue([]),
  queryOne: vi.fn().mockResolvedValue(null),
  getPool: vi.fn().mockReturnValue({
    connect: vi.fn().mockResolvedValue({
      query: vi.fn().mockResolvedValue({ rows: [] }),
      release: vi.fn(),
    }),
  }),
  queryWith: vi.fn().mockResolvedValue([]),
  queryOneWith: vi.fn().mockImplementation(async (_exec: unknown, sql: string) => {
    if (typeof sql === "string" && sql.includes("INSERT INTO messages") && sql.includes("RETURNING id, created_at")) {
      return { id: 1, created_at: new Date().toISOString() };
    }
    return null;
  }),
  executeWith: vi.fn().mockResolvedValue(1),
  withTransaction: vi.fn().mockImplementation(async (fn: (client: unknown) => Promise<unknown>) => {
    const stubClient = {
      query: vi.fn().mockResolvedValue({ rows: [] }),
      release: vi.fn(),
    };
    return await fn(stubClient);
  }),
}));

const mockClaimRunLeaseAndFlipToRunning = vi.fn().mockResolvedValue({
  outcome: "claimed",
  previousStatus: "paused_wake",
  lease: {
    sessionId: "s1", missionRunId: "run-1", ownerId: "test-owner",
    processKind: "electron_main",
    acquiredAt: new Date(), heartbeatAt: new Date(), expiresAt: new Date(),
  },
  wakeCancelledCount: 0,
});

vi.mock("@vex-agent/engine/runtime/lease-and-status.js", () => ({
  claimRunLeaseAndFlipToRunning: (...a: unknown[]) => mockClaimRunLeaseAndFlipToRunning(...a),
  claimSessionLease: vi.fn().mockResolvedValue({
    outcome: "claimed",
    lease: { sessionId: "s1", missionRunId: null, ownerId: "test-owner", processKind: "electron_main", acquiredAt: new Date(), heartbeatAt: new Date(), expiresAt: new Date() },
  }),
  observeAndApplyControl: vi.fn().mockResolvedValue({ outcome: "no_request" }),
}));

vi.mock("@vex-agent/engine/runtime/lease-handle.js", () => ({
  createLeaseHandle: vi.fn().mockReturnValue({
    lease: { sessionId: "s1", missionRunId: null, ownerId: "test-owner", processKind: "electron_main", acquiredAt: new Date(), heartbeatAt: new Date(), expiresAt: new Date() },
    ownerId: "test-owner",
    release: vi.fn().mockResolvedValue(undefined),
    onLeaseLost: vi.fn(),
  }),
}));

vi.mock("@vex-agent/engine/runtime/release-and-emit.js", () => ({
  releaseLeaseAndEmitControlState: vi.fn().mockResolvedValue(undefined),
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

const { routeUserMessage } = await import("../../../vex-agent/engine/ingress.js");

const agentResult = { text: "hi", toolCallsMade: 0, pendingApprovals: [], stopReason: null, missionStatus: null };
const setupResult = { ...agentResult, missionStatus: "draft" as const };
const resumeResult = { text: null, toolCallsMade: 2, pendingApprovals: [], stopReason: null, missionStatus: "running" as const };

beforeEach(() => {
  vi.clearAllMocks();
  mockCancelForSession.mockResolvedValue(0);
  mockProcessAgentTurn.mockResolvedValue(agentResult);
  mockProcessMissionSetupTurn.mockResolvedValue(setupResult);
  mockResumeMissionRun.mockResolvedValue(resumeResult);
  mockCasFlipToRunning.mockResolvedValue("paused_wake");
  mockAddOperatorInstruction.mockResolvedValue(undefined);
  mockAddOperatorCue.mockResolvedValue(undefined);
});

describe("ingress.routeUserMessage", () => {
  it("always cancels pending wakes before routing", async () => {
    mockGetActiveRunBySession.mockResolvedValue(null);
    mockGetSession.mockResolvedValue({ id: "s1", mode: "agent", permission: "restricted" });
    mockGetActiveMission.mockResolvedValue(null);

    await routeUserMessage("s1", "hello");

    expect(mockCancelForSession).toHaveBeenCalledWith("s1", "user_preempt");
    expect(mockCancelForSession).toHaveBeenCalledBefore(mockGetActiveRunBySession as never);
  });

  it("resumes a paused_wake mission run — flip status, save preempt msg, resume", async () => {
    mockGetActiveRunBySession.mockResolvedValue({ id: "run-1", status: "paused_wake" });

    const result = await routeUserMessage("s1", "can you pause?");

    expect(result).toBe(resumeResult);
    // Puzzle 3: production migrated from the non-atomic `casFlipToRunning`
    // + appendMessage pattern to the atomic `claimRunLeaseAndFlipToRunning`
    // helper. Assert the new helper was called with the paused_wake source.
    expect(mockClaimRunLeaseAndFlipToRunning).toHaveBeenCalledWith(
      expect.objectContaining({
        missionRunId: "run-1",
        fromStatuses: ["paused_wake"],
      }),
    );
    // M6: the wake-preempt route is the ONE disposition with an immediate
    // consequence for the run, and it is now recorded as such rather than
    // sharing a paragraph with every other queued write.
    expect(mockAddOperatorInstruction).toHaveBeenCalledWith(
      "s1",
      "can you pause?",
      "preempted_wake",
      expect.objectContaining({
        target: "mission_run",
        runId: "run-1",
        preempt: "wake",
      }),
    );
    expect(mockAddOperatorCue).toHaveBeenCalled();
    expect(mockResumeMissionRun).toHaveBeenCalledWith(
      "run-1",
      "ingress-preempt-run-1",
    );
    expect(mockProcessAgentTurn).not.toHaveBeenCalled();
  });

  it("persists an interrupt (but does NOT fire a new turn) when the run is paused_approval", async () => {
    mockGetActiveRunBySession.mockResolvedValue({ id: "run-2", status: "paused_approval" });

    const result = await routeUserMessage("s1", "wait!");

    // M6: `QUEUED_INTERRUPT_TEXT` as `TurnResult.text` is retired. The
    // acknowledgement is a durable, user-visible engine notice row written in
    // the same transaction as the instruction, so it survives a reload; the
    // response object carries no ephemeral copy of it.
    expect(result.text).toBeNull();
    expect(result.toolCallsMade).toBe(0);
    expect(mockAddOperatorInstruction).toHaveBeenCalledWith(
      "s1",
      "wait!",
      "queued_interrupt",
      expect.objectContaining({ runStatus: "paused_approval" }),
    );
    expect(mockResumeMissionRun).not.toHaveBeenCalled();
    expect(mockProcessAgentTurn).not.toHaveBeenCalled();
  });

  it("persists an interrupt when the run is still running", async () => {
    mockGetActiveRunBySession.mockResolvedValue({ id: "run-3", status: "running" });

    await routeUserMessage("s1", "FYI");

    expect(mockAddOperatorInstruction).toHaveBeenCalled();
    expect(mockProcessAgentTurn).not.toHaveBeenCalled();
  });

  it("returns a recovery hint instead of empty fallback for paused_error", async () => {
    mockGetActiveRunBySession.mockResolvedValue({ id: "run-4", status: "paused_error" });

    const result = await routeUserMessage("s1", "anything");

    expect(mockAddOperatorInstruction).toHaveBeenCalledWith(
      "s1",
      "anything",
      "queued_interrupt",
      expect.objectContaining({ target: "mission_run", runId: "run-4", runStatus: "paused_error" }),
    );
    expect(result.text).toContain("Recover button");
    expect(result.stopReason).toBeNull();
    expect(mockResumeMissionRun).not.toHaveBeenCalled();
    expect(mockProcessAgentTurn).not.toHaveBeenCalled();
  });

  // M3/M4: the hint must not CLAIM a provider/runtime error for a pause that
  // had neither. `restart_orphan` was parked by the reclaim sweep after Vex
  // died mid-slice; `tool_call_loop` was stopped by the detector. The shared
  // tail (what happened to the message, what clears the pause) stays on all
  // three.
  it.each([
    ["restart_orphan", "Vex restarted while it was executing"],
    ["tool_call_loop", "repeated the same tool call without making progress"],
  ])("names %s as the cause of the pause", async (stopReason, cause) => {
    mockGetActiveRunBySession.mockResolvedValue({
      id: "run-5",
      status: "paused_error",
      stopReason,
    });

    const result = await routeUserMessage("s1", "anything");

    expect(result.text).toContain(cause);
    expect(result.text).not.toContain("provider/runtime error");
    expect(result.text).toContain("Recover button");
  });

  // An unnamed reason keeps today's generic wording rather than a wrong one.
  it("falls back to the generic pause wording for an unnamed stop reason", async () => {
    mockGetActiveRunBySession.mockResolvedValue({
      id: "run-6",
      status: "paused_error",
      stopReason: "some_future_reason",
    });

    const result = await routeUserMessage("s1", "anything");

    expect(result.text).toContain("provider/runtime error");
    expect(result.text).toContain("Recover button");
  });

  it("routes to mission-setup when a draft mission exists and there is no run", async () => {
    mockGetActiveRunBySession.mockResolvedValue(null);
    mockGetSession.mockResolvedValue({ id: "s1", mode: "mission", permission: "restricted" });
    mockGetActiveMission.mockResolvedValue({ id: "m1", status: "draft" });

    const result = await routeUserMessage("s1", "goal is x");

    expect(result).toBe(setupResult);
    // The chat-turn Stop signal (undefined here) is threaded into setup so a
    // Stop pressed during mission SETUP is honoured, mirroring the agent path.
    expect(mockProcessMissionSetupTurn).toHaveBeenCalledWith("s1", "goal is x", undefined);
  });

  it("routes to agent when no mission and no run exist", async () => {
    mockGetActiveRunBySession.mockResolvedValue(null);
    mockGetSession.mockResolvedValue({ id: "s1", mode: "agent", permission: "restricted" });
    mockGetActiveMission.mockResolvedValue(null);

    const result = await routeUserMessage("s1", "hi");

    expect(result).toBe(agentResult);
    // 9-5a threads the chat-turn stop signal (undefined here) to the agent
    // turn; S6 threads the per-turn request options (undefined here) too.
    expect(mockProcessAgentTurn).toHaveBeenCalledWith("s1", "hi", undefined, undefined);
  });

  it("threads per-turn request options to the agent turn (S6)", async () => {
    mockGetActiveRunBySession.mockResolvedValue(null);
    mockGetSession.mockResolvedValue({ id: "s1", mode: "agent", permission: "restricted" });
    mockGetActiveMission.mockResolvedValue(null);

    const result = await routeUserMessage("s1", "hi", undefined, {
      reasoningEffort: "high",
    });

    expect(result).toBe(agentResult);
    expect(mockProcessAgentTurn).toHaveBeenCalledWith("s1", "hi", undefined, {
      reasoningEffort: "high",
    });
  });
});
