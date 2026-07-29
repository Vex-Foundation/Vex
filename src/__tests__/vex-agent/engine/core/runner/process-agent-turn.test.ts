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
const mockEnqueueWake = vi.fn();

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
const { runAgentTurnUnderLease } = await import(
  "../../../../../vex-agent/engine/core/runner/agent.js"
);
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

  // ── processAgentTurn ─────────────────────────────────────────

  describe("processAgentTurn", () => {
    it("saves user message and runs turn loop", async () => {
      mockHydrate.mockResolvedValueOnce(makeHydratedSession());
      mockRunTurnLoop.mockResolvedValueOnce({
        text: "Hello!", toolCallsMade: 0, pendingApprovals: [], stopReason: null,
      });

      const result = await processAgentTurn("session-1", "Hi");

      expect(mockAddMessage).toHaveBeenCalledWith(
        "session-1",
        expect.objectContaining({ role: "user", content: "Hi" }),
        expect.objectContaining({ source: "user", messageType: "chat" }),
      );
      expect(result.text).toBe("Hello!");
      expect(result.missionStatus).toBeNull();
    });

    it("throws if no provider", async () => {
      mockResolveProvider.mockResolvedValueOnce(null);
      await expect(processAgentTurn("session-1", "Hi")).rejects.toThrow("No inference provider");
    });

    it("throws if session not found", async () => {
      mockHydrate.mockResolvedValueOnce(null);
      await expect(processAgentTurn("nonexistent", "Hi")).rejects.toThrow("not found");
    });

    it("synthesises a graceful reply when the loop hits iteration_limit with no text", async () => {
      mockHydrate.mockResolvedValueOnce(makeHydratedSession());
      mockRunTurnLoop.mockResolvedValueOnce({
        text: null, toolCallsMade: 50, pendingApprovals: [], stopReason: "iteration_limit",
      });

      const result = await processAgentTurn("session-1", "Hi");

      expect(result.text).toBe(ITERATION_LIMIT_REPLY);
      expect(result.stopReason).toBe("iteration_limit");
      expect(mockAddMessage).toHaveBeenCalledWith(
        "session-1",
        expect.objectContaining({ role: "assistant", content: ITERATION_LIMIT_REPLY }),
        expect.objectContaining({ source: "assistant", messageType: "chat", visibility: "user" }),
      );
    });

    it("preserves a partial reply on iteration_limit (no synthesis when text exists)", async () => {
      mockHydrate.mockResolvedValueOnce(makeHydratedSession());
      mockRunTurnLoop.mockResolvedValueOnce({
        text: "Partial progress so far.", toolCallsMade: 50, pendingApprovals: [], stopReason: "iteration_limit",
      });

      const result = await processAgentTurn("session-1", "Hi");

      expect(result.text).toBe("Partial progress so far.");
      // No synthesised assistant message persisted (only the user message).
      expect(mockAddMessage).not.toHaveBeenCalledWith(
        "session-1",
        expect.objectContaining({ content: ITERATION_LIMIT_REPLY }),
        expect.anything(),
      );
    });
  });

  // ── runAgentTurnUnderLease — resumed-turn claim hook ─────────

  /**
   * The claim hook is how a resumed turn's durable "I consumed this" marker
   * gets written BY the work it fences instead of before it. Stamping earlier
   * meant any failure in the fallible preparation (provider resolution, the
   * engine cue append, hydrate) permanently suppressed recovery for that
   * approval — the exact failure the marker exists to prevent.
   */
  describe("runAgentTurnUnderLease — resumed-turn claim", () => {
    function provider() {
      return makeProvider() as unknown as Parameters<
        typeof runAgentTurnUnderLease
      >[1];
    }
    const config = {
      provider: "openrouter",
      model: "test",
      contextLimit: 128000,
      maxOutputTokens: 4096,
    } as unknown as Parameters<typeof runAgentTurnUnderLease>[2];

    it("claims only AFTER hydrate and only BEFORE the model call", async () => {
      const order: string[] = [];
      mockHydrate.mockImplementation(async () => {
        order.push("hydrate");
        return makeHydratedSession();
      });
      mockRunTurnLoop.mockImplementation(async () => {
        order.push("turn-loop");
        return {
          text: "ok",
          toolCallsMade: 0,
          pendingApprovals: [],
          stopReason: null,
        };
      });

      await runAgentTurnUnderLease(
        "session-1",
        provider(),
        config,
        undefined,
        async () => {
          order.push("claim");
          return true;
        },
      );

      expect(order).toEqual(["hydrate", "claim", "turn-loop"]);
    });

    it("a hydrate failure never reaches the claim, so the resume stays recoverable", async () => {
      const claim = vi.fn().mockResolvedValue(true);
      mockHydrate.mockResolvedValueOnce(null);

      await expect(
        runAgentTurnUnderLease(
          "session-1",
          provider(),
          config,
          undefined,
          claim,
        ),
      ).rejects.toThrow("not found");

      // Nothing was consumed — a later attempt path can still deliver the wake.
      expect(claim).not.toHaveBeenCalled();
    });

    it("a losing claim abandons the turn without calling the model", async () => {
      mockHydrate.mockResolvedValueOnce(makeHydratedSession());

      const result = await runAgentTurnUnderLease(
        "session-1",
        provider(),
        config,
        undefined,
        async () => false,
      );

      expect(mockRunTurnLoop).not.toHaveBeenCalled();
      expect(result).toMatchObject({ text: null, toolCallsMade: 0 });
    });

    it("no hook (an ordinary turn) runs unchanged", async () => {
      mockHydrate.mockResolvedValueOnce(makeHydratedSession());
      mockRunTurnLoop.mockResolvedValueOnce({
        text: "Hello!",
        toolCallsMade: 0,
        pendingApprovals: [],
        stopReason: null,
      });

      const result = await runAgentTurnUnderLease("session-1", provider(), config);

      expect(mockRunTurnLoop).toHaveBeenCalledTimes(1);
      expect(result.text).toBe("Hello!");
    });
  });
});
