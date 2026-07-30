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
// Guarded writes: `startRunIfNotTerminal` is the resume's running flip,
// `updateStatusIfNotTerminal` the recovery parks. Default = row not terminal.
const mockStartRunIfNotTerminal = vi.fn().mockResolvedValue(true);
const mockUpdateRunStatusIfNotTerminal = vi.fn().mockResolvedValue(true);
const mockEnqueueWake = vi.fn();

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
  startRunIfNotTerminal: (...a: unknown[]) => mockStartRunIfNotTerminal(...a),
  updateStatusIfNotTerminal: (...a: unknown[]) =>
    mockUpdateRunStatusIfNotTerminal(...a),
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

  /**
   * The lease owner every resume entry point claims before calling in. Named
   * here so the propagation assertion below reads against a single value.
   */
  const RESUME_OWNER = "resume-owner-run-1";

  // ── resumeMissionRun ────────────────────────────────────────

  describe("resumeMissionRun", () => {
    it("resumes run and enters loop", async () => {
      mockGetRun.mockResolvedValueOnce({
        id: "run-1", missionId: "mission-1", sessionId: "session-1",
        status: "running", iterationCount: 5,
      });
      mockGetMission.mockResolvedValueOnce({
        id: "mission-1", rootSessionId: "session-1", status: "running",
        title: "SOL DCA", goal: "Accumulate", capitalSourceJson: {},
        allowedWallets: ["sol"], allowedChains: ["sol"], allowedProtocols: ["sol"],
        riskProfile: "conservative", successCriteriaJson: [], stopConditionsJson: [],
        constraintsJson: {}, createdAt: "", updatedAt: "", approvedAt: "",
      });
      mockHydrate.mockResolvedValueOnce(makeHydratedSession({
        sessionKind: "mission", missionId: "mission-1", missionRunId: "run-1",
      }));
      mockRunTurnLoop.mockResolvedValueOnce({
        text: "Resumed", toolCallsMade: 1, pendingApprovals: [], stopReason: null,
      });

      const result = await resumeMissionRun("run-1", RESUME_OWNER);

      expect(result.text).toBe("Resumed");
      expect(result.missionStatus).toBe("running");
    });

    /**
     * Ownership propagation, end to end through the real resume chain
     * (`resumeMissionRun` → `resumePreparedMissionRun` → loop config). Without
     * it the resumed turn loop cannot prove it holds the lease, so a prepared
     * compaction cutover is silently never applied on any resumed slice.
     */
    it("threads the CALLER's lease owner id into the resumed turn loop config", async () => {
      mockGetRun.mockResolvedValueOnce({
        id: "run-1", missionId: "mission-1", sessionId: "session-1",
        status: "paused_wake", iterationCount: 5,
      });
      mockGetMission.mockResolvedValueOnce(makeReadyMission({ status: "running" }));
      mockHydrate.mockResolvedValueOnce(makeHydratedSession({
        sessionKind: "mission", missionId: "mission-1", missionRunId: "run-1",
      }));
      mockRunTurnLoop.mockResolvedValueOnce({
        text: "Resumed", toolCallsMade: 0, pendingApprovals: [], stopReason: null,
      });

      await resumeMissionRun("run-1", RESUME_OWNER);

      const [, , , , , , , loopConfig] = mockRunTurnLoop.mock.calls[0]!;
      expect((loopConfig as { runnerOwnerId?: string }).runnerOwnerId).toBe(
        RESUME_OWNER,
      );
    });

    // WP-I1: the hard deadline holds ACROSS resumes — it is recomputed from
    // the same immutable `missionRunStartedAt` each time, not reset to "now".
    // (No `contractSnapshotJson` on the run -> frozen duration null -> 60min.)
    it("threads the hard mission deadline into loopConfig and context on resume", async () => {
      mockGetRun.mockResolvedValueOnce({
        id: "run-1", missionId: "mission-1", sessionId: "session-1",
        status: "running", iterationCount: 5,
      });
      mockGetMission.mockResolvedValueOnce({
        id: "mission-1", rootSessionId: "session-1", status: "running",
        title: "SOL DCA", goal: "Accumulate", capitalSourceJson: {},
        allowedWallets: ["sol"], allowedChains: ["sol"], allowedProtocols: ["sol"],
        riskProfile: "conservative", successCriteriaJson: [], stopConditionsJson: [],
        constraintsJson: {}, createdAt: "", updatedAt: "", approvedAt: "",
      });
      mockHydrate.mockResolvedValueOnce(makeHydratedSession({
        sessionKind: "mission", missionId: "mission-1", missionRunId: "run-1",
        missionRunStartedAt: "2026-01-01T00:00:00.000Z",
      }));
      mockRunTurnLoop.mockResolvedValueOnce({
        text: "Resumed", toolCallsMade: 0, pendingApprovals: [], stopReason: null,
      });

      await resumeMissionRun("run-1", RESUME_OWNER);

      const [context, , , , , , , loopConfig] = mockRunTurnLoop.mock.calls[0]!;
      const expectedMs = Date.parse("2026-01-01T00:00:00.000Z") + 60 * 60_000;
      expect((loopConfig as { missionDeadlineMs: number }).missionDeadlineMs).toBe(expectedMs);
      expect((context as { missionDeadline: string }).missionDeadline).toBe(
        new Date(expectedMs).toISOString(),
      );
    });

    // WP-I1 freeze (Codex review Q1): a post-start mutation of the LIVE mission
    // row's durationMinutes must NOT move the enforced deadline on resume. The
    // box is re-derived from the run's FROZEN contract snapshot + immutable
    // started_at, so a wake/resume always yields the ORIGINAL deadline.
    it("uses the FROZEN snapshot durationMinutes on resume, ignoring a post-start mutation of the live mission row", async () => {
      mockGetRun.mockResolvedValueOnce({
        id: "run-1", missionId: "mission-1", sessionId: "session-1",
        status: "running", iterationCount: 5,
        // Committed with a 5-minute box.
        contractSnapshotJson: { frozenMission: { draft: { durationMinutes: 5 } } },
      });
      // Live mission row was edited to a 999-minute box AFTER the run started —
      // must be ignored by the deadline enforcer.
      mockGetMission.mockResolvedValueOnce({
        id: "mission-1", rootSessionId: "session-1", status: "running",
        title: "SOL DCA", goal: "Accumulate", capitalSourceJson: {},
        allowedWallets: ["sol"], allowedChains: ["sol"], allowedProtocols: ["sol"],
        riskProfile: "conservative", successCriteriaJson: [], stopConditionsJson: [],
        constraintsJson: { durationMinutes: 999 }, createdAt: "", updatedAt: "", approvedAt: "",
      });
      mockHydrate.mockResolvedValueOnce(makeHydratedSession({
        sessionKind: "mission", missionId: "mission-1", missionRunId: "run-1",
        missionRunStartedAt: "2026-01-01T00:00:00.000Z",
      }));
      mockRunTurnLoop.mockResolvedValueOnce({
        text: "Resumed", toolCallsMade: 0, pendingApprovals: [], stopReason: null,
      });

      await resumeMissionRun("run-1", RESUME_OWNER);

      const [context, , , , , , , loopConfig] = mockRunTurnLoop.mock.calls[0]!;
      const expectedMs = Date.parse("2026-01-01T00:00:00.000Z") + 5 * 60_000; // frozen 5, NOT live 999
      expect((loopConfig as { missionDeadlineMs: number }).missionDeadlineMs).toBe(expectedMs);
      expect((context as { missionDeadline: string }).missionDeadline).toBe(
        new Date(expectedMs).toISOString(),
      );
    });

    it("pauses the run with evidence when resume throws inside the loop", async () => {
      mockGetRun.mockResolvedValueOnce({
        id: "run-1", missionId: "mission-1", sessionId: "session-1",
        status: "paused_wake", iterationCount: 5,
      });
      mockGetMission.mockResolvedValueOnce(makeReadyMission({ status: "running" }));
      mockHydrate.mockResolvedValueOnce(makeHydratedSession({
        sessionKind: "mission", missionId: "mission-1", missionRunId: "run-1",
      }));
      mockRunTurnLoop.mockRejectedValueOnce(new Error("provider exploded"));

      await expect(resumeMissionRun("run-1", RESUME_OWNER)).rejects.toBeInstanceOf(MissionRunPausedError);

      // The resume's running flip goes through the terminal-guarded CAS.
      expect(mockStartRunIfNotTerminal).toHaveBeenCalledWith("run-1");
      expect(mockUpdateRunStatus).toHaveBeenCalledWith(
        "run-1",
        "paused_error",
        "provider_error",
        expect.objectContaining({
          evidence: expect.objectContaining({
            errorMessage: "provider exploded",
            runId: "run-1",
          }),
        }),
        expect.anything(),
      );
    });

    it("throws if run not found", async () => {
      mockGetRun.mockResolvedValueOnce(null);
      await expect(resumeMissionRun("nonexistent", RESUME_OWNER)).rejects.toThrow("not found");
    });

    // ── Resumed-turn claim hook ──────────────────────────────

    /**
     * The approval-resume path passes its durable "I consumed this" marker in
     * here so it is written by the run core rather than before it. Stamping it
     * earlier meant a failure anywhere in the pre-resume reads (provider,
     * config, mission lookup) permanently suppressed recovery for that
     * approval — the exact failure the marker exists to prevent.
     */
    describe("resumed-turn claim", () => {
      function readyRun() {
        mockGetRun.mockResolvedValueOnce({
          id: "run-1", missionId: "mission-1", sessionId: "session-1",
          status: "paused_approval", iterationCount: 1,
        });
        mockGetMission.mockResolvedValueOnce(makeReadyMission({ status: "running" }));
        mockHydrate.mockResolvedValueOnce(makeHydratedSession({
          sessionKind: "mission", missionId: "mission-1", missionRunId: "run-1",
        }));
        mockRunTurnLoop.mockResolvedValueOnce({
          text: "resumed", toolCallsMade: 0, pendingApprovals: [], stopReason: null,
        });
      }

      it("claims only after the pre-resume reads, and before the run core", async () => {
        const order: string[] = [];
        mockGetRun.mockResolvedValueOnce({
          id: "run-1", missionId: "mission-1", sessionId: "session-1",
          status: "paused_approval", iterationCount: 1,
        });
        mockGetMission.mockImplementationOnce(async () => {
          order.push("mission-read");
          return makeReadyMission({ status: "running" });
        });
        mockHydrate.mockResolvedValueOnce(makeHydratedSession({
          sessionKind: "mission", missionId: "mission-1", missionRunId: "run-1",
        }));
        mockRunTurnLoop.mockImplementationOnce(async () => {
          order.push("turn-loop");
          return { text: "resumed", toolCallsMade: 0, pendingApprovals: [], stopReason: null };
        });

        await resumeMissionRun("run-1", RESUME_OWNER, async () => {
          order.push("claim");
          return true;
        });

        expect(order).toEqual(["mission-read", "claim", "turn-loop"]);
      });

      it("a pre-resume failure never reaches the claim", async () => {
        const claim = vi.fn().mockResolvedValue(true);
        mockGetRun.mockResolvedValueOnce({
          id: "run-1", missionId: "mission-1", sessionId: "session-1",
          status: "paused_approval", iterationCount: 1,
        });
        mockResolveProvider.mockResolvedValueOnce(null);

        await expect(resumeMissionRun("run-1", RESUME_OWNER, claim)).rejects.toThrow(
          "No inference provider",
        );

        // Unconsumed — a later attempt path can still deliver the resume.
        expect(claim).not.toHaveBeenCalled();
      });

      it("a losing claim abandons the resume without running the turn", async () => {
        readyRun();

        const result = await resumeMissionRun("run-1", RESUME_OWNER, async () => false);

        expect(mockRunTurnLoop).not.toHaveBeenCalled();
        expect(result).toMatchObject({ text: null, toolCallsMade: 0 });
      });
    });
  });
});
