import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ─────────────────────────────────────────────────────

const mockResolveProvider = vi.fn();
const mockAddMessage = vi.fn();
const mockAddEngineMessage = vi.fn();
const mockHydrate = vi.fn();
const mockRunTurnLoop = vi.fn();
const mockGetMission = vi.fn();
const mockCreateDraft = vi.fn();
const mockUpdateDraft = vi.fn();
const mockSetMissionStatus = vi.fn();
const mockSetApprovedAt = vi.fn();
const mockCreateRun = vi.fn();
const mockGetRun = vi.fn();
const mockUpdateRunStatus = vi.fn();
// Terminal-safe CAS used by the RECOVERY writes (paused_wake / paused_error).
// Defaults to `true` = the row was still non-terminal.
const mockUpdateRunStatusIfNotTerminal = vi.fn().mockResolvedValue(true);
const mockEnqueueWake = vi.fn();
const mockApplyUserStopTransaction = vi.fn();

// The paused_error park now runs the DURABLE OPERATOR-STOP CONSUMER inside its
// own transaction (see `mission-auto-retry.ts`): it takes the session control
// lock and gates on a queued `stop_terminal` request before writing. Both
// collaborators are stubbed to "no stop queued" here so these tests keep
// asserting the park itself.
vi.mock(
  "@vex-agent/engine/runtime/lease-and-status/operator-stop-boundary.js",
  () => ({ gateOnOperatorStopWithClient: async () => ({ kind: "clear" }) }),
);
vi.mock(
  "@vex-agent/engine/runtime/lease-and-status/session-control-lock.js",
  () => ({ acquireSessionControlLock: async () => undefined }),
);

vi.mock("@vex-agent/inference/registry.js", () => ({
  resolveProvider: () => mockResolveProvider(),
}));

vi.mock("@vex-agent/engine/events/index.js", () => ({
  appendMessage: (...a: unknown[]) => mockAddMessage(...a),
  appendEngineMessage: (...a: unknown[]) => mockAddEngineMessage(...a),
  emitTranscriptAppend: vi.fn(),
}));

vi.mock("@vex-agent/db/repos/messages.js", () => ({
  addMessage: (...a: unknown[]) => mockAddMessage(...a),
  addEngineMessage: (...a: unknown[]) => mockAddEngineMessage(...a),
  addMessageReturningId: vi.fn().mockResolvedValue({
    id: 1, role: "assistant", content: "", timestamp: new Date().toISOString(),
  }),
  getLiveMessages: vi.fn().mockResolvedValue([]),
}));

vi.mock("../../../../../vex-agent/engine/core/hydrate.js", () => ({
  hydrateEngineSession: (...a: unknown[]) => mockHydrate(...a),
}));

vi.mock("../../../../../vex-agent/engine/core/turn-loop.js", () => ({
  runTurnLoop: (...a: unknown[]) => mockRunTurnLoop(...a),
}));

vi.mock("@vex-agent/db/repos/missions.js", () => ({
  createDraft: (...a: unknown[]) => mockCreateDraft(...a),
  getMission: (...a: unknown[]) => mockGetMission(...a),
  // Puzzle 04 acceptance gate uses a tx-aware lookup — reuse the same mock.
  getMissionForUpdate: (...a: unknown[]) => mockGetMission(a[1]),
  updateDraft: (...a: unknown[]) => mockUpdateDraft(...a),
  setStatus: (...a: unknown[]) => mockSetMissionStatus(...a),
  setApprovedAt: (...a: unknown[]) => mockSetApprovedAt(...a),
  updateAcceptance: vi.fn(),
  clearAcceptance: vi.fn(),
  getMissionBySession: vi.fn().mockResolvedValue(null),
}));

// Puzzle 04 atomic gate + flip + createRun. Default = committed
// (matches `makeReadyMission()` happy path). The mock's `committed`
// outcome carries the same mission row + a synthetic snapshot so the
// downstream `startMissionRunBody` flow stays unchanged. Tests that
// exercise gate-rejection paths override this.
const mockCommitMissionStart = vi.fn();
vi.mock("../../../../../vex-agent/engine/mission/commit-start.js", () => ({
  commitMissionStart: (...a: unknown[]) => mockCommitMissionStart(...a),
}));

vi.mock("@vex-agent/db/repos/mission-runs.js", () => ({
  createRun: (...a: unknown[]) => mockCreateRun(...a),
  getRun: (...a: unknown[]) => mockGetRun(...a),
  updateStatus: (...a: unknown[]) => mockUpdateRunStatus(...a),
  updateStatusIfNotTerminal: (...a: unknown[]) =>
    mockUpdateRunStatusIfNotTerminal(...a),
  startRunIfNotTerminal: vi.fn().mockResolvedValue(true),
  getActiveRun: vi.fn().mockResolvedValue(null),
  getActiveRunBySession: vi.fn().mockResolvedValue(null),
  getLatestFailedRunBySession: vi.fn().mockResolvedValue(null),
}));

vi.mock("@vex-agent/db/repos/loop-wake.js", () => ({
  enqueue: (...a: unknown[]) => mockEnqueueWake(...a),
}));

vi.mock("@vex-agent/tools/registry.js", () => ({
  getOpenAITools: vi.fn().mockReturnValue([]),
}));

vi.mock("@vex-agent/db/repos/sessions.js", () => ({
  getSession: vi.fn(),
  updateTokenCount: vi.fn(),
  createSession: vi.fn(),
}));

vi.mock("@utils/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
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

vi.mock("@vex-agent/engine/runtime/lease-and-status.js", () => ({
  claimRunLeaseAndFlipToRunning: vi.fn().mockResolvedValue({
    outcome: "claimed", previousStatus: "paused_wake",
    lease: { sessionId: "s", missionRunId: "r", ownerId: "test-owner", processKind: "electron_main", acquiredAt: new Date(), heartbeatAt: new Date(), expiresAt: new Date() },
    wakeCancelledCount: 0,
  }),
  claimSessionLease: vi.fn().mockResolvedValue({
    outcome: "claimed",
    lease: { sessionId: "s", missionRunId: null, ownerId: "test-owner", processKind: "electron_main", acquiredAt: new Date(), heartbeatAt: new Date(), expiresAt: new Date() },
  }),
  observeAndApplyControl: vi.fn().mockResolvedValue({ outcome: "no_request" }),
  applyUserStopTransaction: (...a: unknown[]) => mockApplyUserStopTransaction(...a),
  // The `paused_wake` park in `mission-finalize.ts` carries the durable
  // operator-Stop consumer; stubbed to "no stop raced us".
  gateOnOperatorStopWithClient: async () => ({ kind: "clear" }),
  withSessionControlLock: async <T>(
    _sessionId: string,
    fn: (client: unknown) => Promise<T>,
  ): Promise<T> => fn({}),
}));

vi.mock("@vex-agent/engine/runtime/lease-handle.js", () => ({
  createLeaseHandle: vi.fn().mockReturnValue({
    lease: { sessionId: "s", missionRunId: null, ownerId: "test-owner", processKind: "electron_main", acquiredAt: new Date(), heartbeatAt: new Date(), expiresAt: new Date() },
    ownerId: "test-owner",
    release: vi.fn().mockResolvedValue(undefined),
    onLeaseLost: vi.fn(),
  }),
}));

vi.mock("@vex-agent/engine/runtime/release-and-emit.js", () => ({
  releaseLeaseAndEmitControlState: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@vex-agent/tools/protocols/catalog.js", () => ({
  PROTOCOL_TOOLS: [],
  PROTOCOL_NAMESPACE_ALLOWLIST: [],
}));

const runnerModule = await import("../../../../../vex-agent/engine/core/runner.js");
const { processAgentTurn, processMissionSetupTurn, startMission, resumeMissionRun } = runnerModule;
const { MissionRunPausedError } = await import("../../../../../vex-agent/engine/types.js");
const { ITERATION_LIMIT_REPLY } = await import("../../../../../vex-agent/engine/core/runner/shared.js");
const { signalMissionRunAbortLocal } = await import("../../../../../vex-agent/engine/core/runner/abort.js");

function makeProvider() {
  return {
    loadConfig: vi.fn().mockResolvedValue({
      provider: "openrouter",
      model: "test",
      contextLimit: 128000,
      maxOutputTokens: 4096,
    }),
  };
}

function makeHydratedSession(overrides = {}) {
  return {
    context: {
      sessionId: "session-1",
      sessionKind: "agent",
      sessionPermission: "restricted",
      missionId: null,
      missionRunId: null,
      loadedDocuments: new Map(),
      ...overrides,
    },
    messages: [],
    summary: null,
    tokenCount: 0,
  };
}

function makeMission(overrides = {}) {
  return {
    id: "mission-1",
    rootSessionId: "session-1",
    status: "draft",
    title: null,
    goal: null,
    capitalSourceJson: {},
    allowedWallets: [],
    allowedChains: [],
    allowedProtocols: [],
    riskProfile: null,
    successCriteriaJson: [],
    stopConditionsJson: [],
    constraintsJson: {},
    createdAt: "2026-03-29",
    updatedAt: "2026-03-29",
    approvedAt: null,
    // Puzzle 04: acceptance + lineage columns (mig 023). Default to
    // unaccepted — `makeReadyMission` opts in by writing the hash.
    acceptedContractHash: null,
    acceptedContractAt: null,
    acceptedContractBy: null,
    contractHashVersion: null,
    renewedFromMissionId: null,
    ...overrides,
  };
}

function makeReadyMission(overrides = {}) {
  return makeMission({
    status: "ready",
    title: "SOL DCA",
    goal: "Accumulate 10 SOL",
    capitalSourceJson: { type: "wallet", amount: "500 USDC" },
    allowedWallets: ["solana"],
    allowedChains: ["solana"],
    allowedProtocols: ["solana"],
    riskProfile: "conservative",
    successCriteriaJson: ["Accumulated 10 SOL"],
    stopConditionsJson: ["capital_depleted"],
    constraintsJson: {},
    // Host-only acceptance via `mission.acceptContract` (mig 023) —
    // a non-null hash signals the user committed to the contract.
    acceptedContractHash: "0".repeat(64),
    acceptedContractAt: "2026-03-29T00:00:00.000Z",
    acceptedContractBy: "host",
    contractHashVersion: 1,
    ...overrides,
  });
}

// Resolve the sessions repo once; mocks are reused inside beforeEach.
const sessionsRepoMockedSetup = await import("@vex-agent/db/repos/sessions.js");

describe("runner", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveProvider.mockResolvedValue(makeProvider());
    mockEnqueueWake.mockResolvedValue({
      id: "wake-1",
      sessionId: "session-1",
      missionRunId: "run-1",
      dueAt: "2026-03-29T00:00:05.000Z",
      status: "pending",
      reason: "iteration_limit: runtime slice exhausted; continue autonomously",
      payload: { trigger: "iteration_limit", automatic: true },
      createdAt: "2026-03-29T00:00:00.000Z",
      consumedAt: null,
      cancelledAt: null,
      cancelledReason: null,
    });
    // sessionsRepo.getSession is needed by startMission to read session.permission
    vi.mocked(sessionsRepoMockedSetup.getSession).mockResolvedValue({
      id: "session-1",
      mode: "mission",
      permission: "restricted",
      tokenCount: 0,
    } as unknown as Awaited<ReturnType<typeof sessionsRepoMockedSetup.getSession>>);
    // Puzzle 04 — default the atomic gate to `committed`. Individual
    // tests override to exercise rejection paths.
    mockCommitMissionStart.mockImplementation(async (input: { missionId: string; runId: string }) => ({
      outcome: "committed" as const,
      mission: makeReadyMission(),
      runId: input.runId,
      contractSnapshot: {
        version: 1,
        capturedAt: "2026-05-22T11:00:00.000Z",
        missionPromptContext: "# Mission",
        frozenMission: {},
      },
    }));
  });

  // ── startMission ────────────────────────────────────────────

  describe("startMission", () => {
    it("validates, freezes, creates run, and enters loop", async () => {
      mockGetMission.mockResolvedValueOnce(makeReadyMission());
      mockHydrate.mockResolvedValueOnce(makeHydratedSession({ sessionKind: "mission" }));
      mockRunTurnLoop.mockResolvedValueOnce({
        text: "Starting mission...", toolCallsMade: 2, pendingApprovals: [], stopReason: null,
      });

      const result = await startMission("mission-1");

      // Puzzle 04: state mutations live inside `commitMissionStart`,
      // which is mocked here. We assert the helper was called with the
      // expected (missionId, runId) pair and that the turn loop ran
      // afterwards. Direct setStatus/createRun assertions move into
      // `commit-start.test.ts` where the helper is exercised.
      expect(mockCommitMissionStart).toHaveBeenCalledTimes(1);
      const commitArgs = mockCommitMissionStart.mock.calls[0]![0];
      expect(commitArgs.missionId).toBe("mission-1");
      expect(commitArgs.runId).toMatch(/^run-/);
      expect(mockRunTurnLoop).toHaveBeenCalled();
      expect(result.text).toBe("Starting mission...");
      expect(result.missionStatus).toBe("running");
    });

    // WP-I1: the hard deadline is computed from the run's immutable
    // `missionRunStartedAt` (+ FROZEN snapshot duration -> env -> 60min
    // default) and threaded into both `loopConfig.missionDeadlineMs`
    // (enforcement) and `context.missionDeadline` (the agent-facing Runtime
    // Clock). The default commit snapshot has no `durationMinutes` -> 60.
    it("threads the hard mission deadline into loopConfig and context", async () => {
      mockGetMission.mockResolvedValueOnce(makeReadyMission());
      mockHydrate.mockResolvedValueOnce(makeHydratedSession({
        sessionKind: "mission",
        missionRunStartedAt: "2026-01-01T00:00:00.000Z",
      }));
      mockRunTurnLoop.mockResolvedValueOnce({
        text: "Starting mission...", toolCallsMade: 0, pendingApprovals: [], stopReason: null,
      });

      await startMission("mission-1");

      expect(mockRunTurnLoop).toHaveBeenCalled();
      const [context, , , , , , , loopConfig] = mockRunTurnLoop.mock.calls[0]!;
      const expectedMs = Date.parse("2026-01-01T00:00:00.000Z") + 60 * 60_000;
      expect((loopConfig as { missionDeadlineMs: number }).missionDeadlineMs).toBe(expectedMs);
      expect((context as { missionDeadline: string }).missionDeadline).toBe(
        new Date(expectedMs).toISOString(),
      );
    });

    it("resolves no deadline (fail-open) when the run has no started_at", async () => {
      mockGetMission.mockResolvedValueOnce(makeReadyMission());
      mockHydrate.mockResolvedValueOnce(makeHydratedSession({ sessionKind: "mission" }));
      mockRunTurnLoop.mockResolvedValueOnce({
        text: "Starting mission...", toolCallsMade: 0, pendingApprovals: [], stopReason: null,
      });

      await startMission("mission-1");

      const [, , , , , , , loopConfig] = mockRunTurnLoop.mock.calls[0]!;
      expect((loopConfig as { missionDeadlineMs: number | null }).missionDeadlineMs).toBeNull();
    });

    // WP-I1 freeze: the box is resolved from the FROZEN contract snapshot's
    // `durationMinutes`, never the live mission row — so a per-mission box is
    // pinned at commit time.
    it("freezes the deadline from the contract snapshot's durationMinutes, not the live mission row", async () => {
      mockCommitMissionStart.mockImplementationOnce(async (input: { missionId: string; runId: string }) => ({
        outcome: "committed" as const,
        // Live row claims a 999-min box; the frozen snapshot says 5 — the
        // enforcer must use the frozen 5.
        mission: makeReadyMission({ constraintsJson: { durationMinutes: 999 } }),
        runId: input.runId,
        contractSnapshot: {
          version: 1,
          capturedAt: "2026-05-22T11:00:00.000Z",
          missionPromptContext: "# Mission",
          frozenMission: { draft: { durationMinutes: 5 } },
        },
      }));
      mockGetMission.mockResolvedValueOnce(makeReadyMission({ constraintsJson: { durationMinutes: 999 } }));
      mockHydrate.mockResolvedValueOnce(makeHydratedSession({
        sessionKind: "mission",
        missionRunStartedAt: "2026-01-01T00:00:00.000Z",
      }));
      mockRunTurnLoop.mockResolvedValueOnce({
        text: "Starting mission...", toolCallsMade: 0, pendingApprovals: [], stopReason: null,
      });

      await startMission("mission-1");

      const [, , , , , , , loopConfig] = mockRunTurnLoop.mock.calls[0]!;
      const expectedMs = Date.parse("2026-01-01T00:00:00.000Z") + 5 * 60_000;
      expect((loopConfig as { missionDeadlineMs: number }).missionDeadlineMs).toBe(expectedMs);
    });

    it("marks only goal_reached as completed", async () => {
      mockGetMission.mockResolvedValueOnce(makeReadyMission());
      mockHydrate.mockResolvedValueOnce(makeHydratedSession({ sessionKind: "mission" }));
      mockRunTurnLoop.mockResolvedValueOnce({
        text: "Done",
        toolCallsMade: 1,
        pendingApprovals: [],
        stopReason: "goal_reached",
        stopPayload: { summary: "Target hit" },
      });

      const result = await startMission("mission-1");

      expect(result.missionStatus).toBe("completed");
      expect(mockSetMissionStatus).toHaveBeenLastCalledWith("mission-1", "completed");
      // Terminal-stop precedence: a business outcome reaches terminal through
      // the CAS, so a Stop that already committed is not overwritten. The
      // assertion is unchanged in strength — only the helper it names.
      expect(mockUpdateRunStatusIfNotTerminal).toHaveBeenCalledWith(
        expect.any(String),
        "completed",
        "goal_reached",
        { summary: "Target hit" },
      );
    });

    it("marks accepted non-success stop reasons as failed", async () => {
      mockGetMission.mockResolvedValueOnce(makeReadyMission({
        stopConditionsJson: ["no_viable_opportunity"],
      }));
      mockHydrate.mockResolvedValueOnce(makeHydratedSession({ sessionKind: "mission" }));
      mockRunTurnLoop.mockResolvedValueOnce({
        text: "No viable setup",
        toolCallsMade: 1,
        pendingApprovals: [],
        stopReason: "no_viable_opportunity",
        stopPayload: { summary: "No viable setup" },
      });

      const result = await startMission("mission-1");

      expect(result.missionStatus).toBe("failed");
      expect(mockSetMissionStatus).toHaveBeenLastCalledWith("mission-1", "failed");
      expect(mockUpdateRunStatusIfNotTerminal).toHaveBeenCalledWith(
        expect.any(String),
        "failed",
        "no_viable_opportunity",
        { summary: "No viable setup" },
      );
    });

    it("marks emergency stops as failed", async () => {
      mockGetMission.mockResolvedValueOnce(makeReadyMission());
      mockHydrate.mockResolvedValueOnce(makeHydratedSession({ sessionKind: "mission" }));
      mockRunTurnLoop.mockResolvedValueOnce({
        text: "Emergency",
        toolCallsMade: 1,
        pendingApprovals: [],
        stopReason: "emergency_stop",
        stopPayload: { summary: "Wallet state cannot be verified" },
      });

      const result = await startMission("mission-1");

      expect(result.missionStatus).toBe("failed");
      expect(mockSetMissionStatus).toHaveBeenLastCalledWith("mission-1", "failed");
      expect(mockUpdateRunStatusIfNotTerminal).toHaveBeenCalledWith(
        expect.any(String),
        "failed",
        "emergency_stop",
        { summary: "Wallet state cannot be verified" },
      );
    });

    it("schedules wake continuation instead of failing on iteration_limit", async () => {
      mockGetMission.mockResolvedValueOnce(makeReadyMission());
      mockHydrate.mockResolvedValueOnce(makeHydratedSession({ sessionKind: "mission" }));
      mockRunTurnLoop.mockResolvedValueOnce({
        text: "Still working",
        toolCallsMade: 50,
        pendingApprovals: [],
        stopReason: "iteration_limit",
      });

      const result = await startMission("mission-1");

      expect(result.missionStatus).toBe("running");
      expect(mockSetMissionStatus).not.toHaveBeenCalledWith("mission-1", "failed");
      expect(mockEnqueueWake).toHaveBeenCalled();
      const wakeInput = mockEnqueueWake.mock.calls[0]![0] as {
        sessionId: string;
        missionRunId: string;
        payload: Record<string, unknown>;
      };
      expect(wakeInput.sessionId).toBe("session-1");
      expect(wakeInput.missionRunId).toEqual(expect.stringMatching(/^run-/));
      expect(wakeInput.payload).toMatchObject({ trigger: "iteration_limit", automatic: true });
      // Guarded CAS, not the unconditional write: parking for a wake must not
      // re-open a run an operator Stop already took terminal.
      expect(mockUpdateRunStatusIfNotTerminal).toHaveBeenCalledWith(
        expect.any(String),
        "paused_wake",
        "waiting_for_wake",
        expect.objectContaining({
          summary: expect.stringContaining("iteration_limit"),
          evidence: expect.objectContaining({ trigger: "iteration_limit" }),
        }),
        // The park now runs inside the durable-Stop consumer's transaction, so
        // it carries that transaction's client.
        expect.anything(),
      );
      expect(mockAddEngineMessage).toHaveBeenCalledWith(
        "session-1",
        expect.stringContaining("runtime_yield"),
        expect.objectContaining({
          messageType: "runtime_yield",
          payload: expect.objectContaining({ trigger: "iteration_limit" }),
        }),
      );
    });

    it("pauses the run with evidence when the mission loop throws", async () => {
      mockGetMission.mockResolvedValueOnce(makeReadyMission());
      mockHydrate.mockResolvedValueOnce(makeHydratedSession({ sessionKind: "mission" }));
      mockRunTurnLoop.mockRejectedValueOnce(new Error("provider exploded"));

      await expect(startMission("mission-1")).rejects.toBeInstanceOf(MissionRunPausedError);

      expect(mockUpdateRunStatus).toHaveBeenCalledWith(
        expect.any(String),
        "paused_error",
        "provider_error",
        expect.objectContaining({
          summary: "provider exploded",
          evidence: expect.objectContaining({
            errorMessage: "provider exploded",
            errorClass: "Error",
            missionId: "mission-1",
          }),
        }),
        expect.anything(),
      );
    });

    it("an operator Stop outranks a throw during unwind — canonical stop, never paused_error", async () => {
      // Codex Wave-1 defect 8: the operator's Stop fires the in-process
      // AbortController; the loop then throws while unwinding (persisting the
      // aborted turn). Routing that through error finalization would overwrite
      // the user's stop with a recoverable-looking `paused_error` AND leave the
      // durable `stop_terminal` request pending forever, because the loop that
      // would have observed it is gone.
      mockGetMission.mockResolvedValueOnce(makeReadyMission());
      mockHydrate.mockResolvedValueOnce(makeHydratedSession({ sessionKind: "mission" }));
      mockApplyUserStopTransaction.mockResolvedValueOnce({
        outcome: "stopped",
        previousStatus: "running",
        rejectedApprovals: 0,
        wakeCancelledCount: 0,
        consumedRequests: 1,
      });
      mockRunTurnLoop.mockImplementationOnce(async (ctx: { missionRunId: string }) => {
        expect(signalMissionRunAbortLocal(ctx.missionRunId)).toBe(true);
        throw new Error("persisting the aborted turn failed");
      });

      await expect(startMission("mission-1")).rejects.toBeInstanceOf(MissionRunPausedError);

      const runId = mockCommitMissionStart.mock.calls[0]![0].runId as string;
      expect(mockApplyUserStopTransaction).toHaveBeenCalledWith({
        sessionId: "session-1",
        missionRunId: runId,
      });
      expect(mockUpdateRunStatus).not.toHaveBeenCalledWith(
        expect.any(String),
        "paused_error",
        expect.anything(),
        expect.anything(),
        expect.anything(),
      );
    });

    it("pauses the run when hydration fails after createRun", async () => {
      mockGetMission.mockResolvedValueOnce(makeReadyMission());
      mockHydrate.mockResolvedValueOnce(null);

      await expect(startMission("mission-1")).rejects.toBeInstanceOf(MissionRunPausedError);

      // The atomic helper runs first; its mocked `committed` outcome
      // returns the synthetic runId. Hydration then fails inside
      // `startMissionRunBody`, which flips the run to paused_error
      // via `finalizeMissionRunError`.
      expect(mockCommitMissionStart).toHaveBeenCalledTimes(1);
      expect(mockUpdateRunStatus).toHaveBeenCalledWith(
        expect.any(String),
        "paused_error",
        "provider_error",
        expect.objectContaining({
          evidence: expect.objectContaining({
            errorMessage: "Session session-1 not found",
          }),
        }),
        expect.anything(),
      );
    });

    it("throws if mission not found (preflight, before lease claim)", async () => {
      mockGetMission.mockResolvedValueOnce(null);
      await expect(startMission("nonexistent")).rejects.toThrow("not found");
    });

    // ── Puzzle 04 atomic gate + flip + createRun ────────────────

    it("rejects an unaccepted mission with a host-accept message", async () => {
      mockGetMission.mockResolvedValueOnce(makeReadyMission());
      mockCommitMissionStart.mockResolvedValueOnce({
        outcome: "not_accepted",
        missionId: "mission-1",
      });
      await expect(startMission("mission-1")).rejects.toThrow(
        "has not been accepted",
      );
      // Atomic helper handles the flip; rejection means createRun
      // never fires (no run row leaked). The atomic helper itself is
      // mocked, so we assert against the runtime side-effects that
      // would follow a committed start — they're absent.
      expect(mockCreateRun).not.toHaveBeenCalled();
      expect(mockRunTurnLoop).not.toHaveBeenCalled();
    });

    it("rejects a mission whose contract drifted since acceptance", async () => {
      mockGetMission.mockResolvedValueOnce(makeReadyMission());
      mockCommitMissionStart.mockResolvedValueOnce({
        outcome: "stale_acceptance",
        acceptedHash: "0".repeat(64),
        currentHash: "1".repeat(64),
      });
      await expect(startMission("mission-1")).rejects.toThrow(
        "contract changed since acceptance",
      );
      expect(mockRunTurnLoop).not.toHaveBeenCalled();
    });

    it("rejects when the locked re-read finds the mission gone (race)", async () => {
      // Initial unlocked `getMission` returns the row, but the atomic
      // gate's row-locked re-read finds it deleted by a concurrent
      // tx between the preflight + lease claim + atomic gate.
      mockGetMission.mockResolvedValueOnce(makeReadyMission());
      mockCommitMissionStart.mockResolvedValueOnce({
        outcome: "mission_not_found",
      });
      await expect(startMission("mission-1")).rejects.toThrow("not found");
      expect(mockRunTurnLoop).not.toHaveBeenCalled();
    });

    it("rejects when the locked row fails isReadyToStart", async () => {
      // Should not normally happen if `clearAcceptance` runs on
      // `updateDraft` (phase 6), but the atomic gate defends against
      // a stale acceptance whose draft fields were emptied out before
      // the lock — phase 6 closes the timing window, this test pins
      // that the helper still rejects fail-closed if it ever happens.
      mockGetMission.mockResolvedValueOnce(makeReadyMission());
      mockCommitMissionStart.mockResolvedValueOnce({
        outcome: "not_ready",
        missingFields: ["goal", "successCriteria"],
      });
      await expect(startMission("mission-1")).rejects.toThrow("not ready");
      expect(mockRunTurnLoop).not.toHaveBeenCalled();
    });

    it("rejects when an active run was created by a concurrent tx", async () => {
      mockGetMission.mockResolvedValueOnce(makeReadyMission());
      mockCommitMissionStart.mockResolvedValueOnce({
        outcome: "active_run_exists",
        missionRunId: "run-existing",
        runStatus: "running",
      });
      await expect(startMission("mission-1")).rejects.toThrow(
        "already has an active run",
      );
      expect(mockRunTurnLoop).not.toHaveBeenCalled();
    });

    it("releases the lease with missionRunId=null when the gate rejects (no phantom run id)", async () => {
      // Codex blocker: the outer `runId` MUST stay null until
      // `commitMissionStart` returns `committed`. Otherwise the
      // `finally` would attribute the lease drop to a run that was
      // never created — phantom missionRunId emitted to the control
      // bus.
      mockGetMission.mockResolvedValueOnce(makeReadyMission());
      mockCommitMissionStart.mockResolvedValueOnce({
        outcome: "not_accepted",
        missionId: "mission-1",
      });

      const releaseModule = await import(
        "../../../../../vex-agent/engine/runtime/release-and-emit.js"
      );
      const releaseMock = vi.mocked(releaseModule.releaseLeaseAndEmitControlState);
      releaseMock.mockClear();

      await expect(startMission("mission-1")).rejects.toThrow();

      expect(releaseMock).toHaveBeenCalledTimes(1);
      const releaseArgs = releaseMock.mock.calls[0]!;
      // Signature: (handle, sessionId, { missionRunId })
      expect(releaseArgs[2]).toEqual({ missionRunId: null });
    });

    it("releases the lease with the real missionRunId on the committed path", async () => {
      mockGetMission.mockResolvedValueOnce(makeReadyMission());
      mockHydrate.mockResolvedValueOnce(makeHydratedSession({ sessionKind: "mission" }));
      mockRunTurnLoop.mockResolvedValueOnce({
        text: "ok", toolCallsMade: 1, pendingApprovals: [], stopReason: null,
      });

      const releaseModule = await import(
        "../../../../../vex-agent/engine/runtime/release-and-emit.js"
      );
      const releaseMock = vi.mocked(releaseModule.releaseLeaseAndEmitControlState);
      releaseMock.mockClear();

      await startMission("mission-1");

      expect(releaseMock).toHaveBeenCalledTimes(1);
      const releaseArgs = releaseMock.mock.calls[0]!;
      const releaseRunId = (releaseArgs[2] as { missionRunId: string | null }).missionRunId;
      expect(releaseRunId).toMatch(/^run-/);
      // The id matches whatever the (mocked) commitMissionStart
      // returned for this invocation — the mock implementation
      // echoes its input `runId`, so the outer scope picked up the
      // real id only AFTER the commit-outcome switch fell through.
      const commitCall = mockCommitMissionStart.mock.calls[0]!;
      const candidateRunId = (commitCall[0] as { runId: string }).runId;
      expect(releaseRunId).toBe(candidateRunId);
    });
  });
});
