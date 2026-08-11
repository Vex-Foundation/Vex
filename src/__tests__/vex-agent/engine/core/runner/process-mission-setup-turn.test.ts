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

  // ── processMissionSetupTurn ────────────────────────────────

  describe("processMissionSetupTurn", () => {
    it("threads measurability warnings into runTurnLoop's prompt options", async () => {
      // The renew gap: warnings were computed by getMissionSetupState but
      // never forwarded, so a renewed draft's stale-denominator warning was
      // invisible until the model happened to call mission_draft_update.
      // This pins the WIRING, runner-level: the prompt options handed to the
      // turn loop must carry the warnings for the current draft.
      mockHydrate.mockResolvedValueOnce(makeHydratedSession({
        sessionKind: "mission",
        missionId: "mission-1",
      }));
      const numberlessCriterion = makeMission({
        title: "Renewed hunt",
        successCriteriaJson: ["Win big"],
      });
      mockGetMission
        .mockResolvedValueOnce(numberlessCriterion)
        .mockResolvedValueOnce(numberlessCriterion);
      mockRunTurnLoop.mockResolvedValueOnce({
        text: "Draft reviewed.",
        toolCallsMade: 0,
        pendingApprovals: [],
        stopReason: null,
      });

      await processMissionSetupTurn("session-1", "review the draft");

      // Located by SHAPE, not position: the prompt-options argument is the
      // one carrying missionSetupContext, wherever the signature puts it.
      const call = mockRunTurnLoop.mock.calls.at(0);
      expect(call).toBeDefined();
      const promptOptions = call?.find(
        (arg): arg is { missionSetupContext?: { warnings?: string[] } } =>
          typeof arg === "object" && arg !== null && "missionSetupContext" in arg,
      );
      expect(promptOptions).toBeDefined();
      expect(promptOptions?.missionSetupContext?.warnings).toEqual([
        expect.stringContaining("contains no number"),
      ]);
    });

    it("adds a DB-not-ready correction when setup text suggests starting a draft", async () => {
      mockHydrate.mockResolvedValueOnce(makeHydratedSession({
        sessionKind: "mission",
        missionId: "mission-1",
      }));
      mockGetMission
        .mockResolvedValueOnce(makeMission({ title: "SOL Flip" }))
        .mockResolvedValueOnce(makeMission({ title: "SOL Flip" }));
      mockRunTurnLoop.mockResolvedValueOnce({
        text: "You can now start the mission from the host UI.",
        toolCallsMade: 1,
        pendingApprovals: [],
        stopReason: null,
      });

      const result = await processMissionSetupTurn("session-1", "ready");

      expect(result.missionStatus).toBe("draft");
      expect(result.text).toContain("You can now start the mission from the host UI.");
      expect(result.text).toContain("Mission draft is not ready in the database.");
      expect(result.text).toContain("Missing fields:");
      expect(mockAddEngineMessage).toHaveBeenCalledWith(
        "session-1",
        expect.stringContaining("Mission draft is not ready in the database."),
        expect.objectContaining({
          source: "engine",
          messageType: "mission_setup",
          visibility: "internal",
          payload: expect.objectContaining({
            missionId: "mission-1",
            status: "draft",
            correction: "db_not_ready_start_suggestion",
          }),
        }),
      );
    });

    it("synthesises a graceful reply on iteration_limit and skips mission-patch parsing", async () => {
      mockHydrate.mockResolvedValueOnce(makeHydratedSession({
        sessionKind: "mission",
        missionId: "mission-1",
      }));
      mockGetMission
        .mockResolvedValueOnce(makeMission({ title: "SOL Flip" }))
        .mockResolvedValueOnce(makeMission({ title: "SOL Flip" }));
      mockRunTurnLoop.mockResolvedValueOnce({
        text: null,
        toolCallsMade: 25,
        pendingApprovals: [],
        stopReason: "iteration_limit",
      });

      const result = await processMissionSetupTurn("session-1", "Hi");

      expect(result.text).toBe(ITERATION_LIMIT_REPLY);
      expect(mockAddMessage).toHaveBeenCalledWith(
        "session-1",
        expect.objectContaining({ role: "assistant", content: ITERATION_LIMIT_REPLY }),
        expect.objectContaining({ source: "assistant", messageType: "mission_setup", visibility: "user" }),
      );
      // Synthesised text must NOT be parsed/applied as a mission draft patch.
      expect(mockUpdateDraft).not.toHaveBeenCalled();
    });

    it("honours a user Stop during setup — no patch applied, no not-ready notice, faithful stopReason, signal threaded to both turn-loop positions", async () => {
      mockHydrate.mockResolvedValueOnce(makeHydratedSession({
        sessionKind: "mission",
        missionId: "mission-1",
      }));
      mockGetMission
        .mockResolvedValueOnce(makeMission({ title: "SOL Flip" }))
        .mockResolvedValueOnce(makeMission({ title: "SOL Flip" }));
      // result.text is BOTH a parseable mission patch (```json block with a
      // title) AND matches START_SUGGESTION_PATTERN ("start the mission") — so
      // the test proves the Stop guard suppresses BOTH the patch-apply and the
      // not-ready notice, not the parser/regex failing to match.
      const stoppedText =
        "You can start the mission now.\n```json\n{\"title\":\"SOL Flip\"}\n```";
      mockRunTurnLoop.mockResolvedValueOnce({
        text: stoppedText,
        toolCallsMade: 2,
        pendingApprovals: [],
        stopReason: "user_stopped",
      });

      const signal = new AbortController().signal;
      const result = await processMissionSetupTurn("session-1", "stop", signal);

      // (1) No mission patch applied from the truncated/partial Stop text.
      expect(mockUpdateDraft).not.toHaveBeenCalled();
      // (2) No not-ready guidance notice appended on Stop.
      expect(mockAddEngineMessage).not.toHaveBeenCalled();
      // (3) Faithful stopReason — not masked to null.
      expect(result.stopReason).toBe("user_stopped");
      // Signal forwarded into runTurnLoop at BOTH pos 10 (abortSignal) and
      // pos 11 (inferenceAbortSignal).
      expect(mockRunTurnLoop.mock.calls[0][9]).toBe(signal);
      expect(mockRunTurnLoop.mock.calls[0][10]).toBe(signal);
    });

    it("carries LIVE plan-mode into the dispatch context during setup (Approach A: plan co-authored with the contract; mission_draft_update stays unblocked via the PLAN_GATE_SAFE_CONTROL safe-list)", async () => {
      // Approach A: when the session has plan-mode enabled, setup co-authors the
      // action plan (HOW) alongside the mission contract (WHAT), so the dispatch
      // context carries the LIVE plan-mode (no longer forced off). The plan
      // execution gate does NOT deadlock contract editing because
      // mission_draft_update is in PLAN_GATE_SAFE_CONTROL (see
      // dispatcher-plan-deny.test.ts for the gate-level proof).
      mockHydrate.mockResolvedValueOnce(makeHydratedSession({
        sessionKind: "mission",
        missionId: "mission-1",
        planMode: true,
      }));
      mockGetMission
        .mockResolvedValueOnce(makeMission({ title: "SOL" }))
        .mockResolvedValueOnce(makeMission({ title: "SOL" }));
      mockRunTurnLoop.mockResolvedValueOnce({
        text: "ok", toolCallsMade: 0, pendingApprovals: [], stopReason: null,
      });

      await processMissionSetupTurn("session-1", "hi");

      const passedContext = mockRunTurnLoop.mock.calls[0][0] as { planMode?: boolean };
      expect(passedContext.planMode).toBe(true);
    });

    it("carries plan-mode OFF (default) into the dispatch context — backward-compat", async () => {
      // Plan-mode off (the default) → setup behaves exactly as before: the
      // dispatch context carries planMode:false and the plan gate fast-returns.
      mockHydrate.mockResolvedValueOnce(makeHydratedSession({
        sessionKind: "mission",
        missionId: "mission-1",
        planMode: false,
      }));
      mockGetMission
        .mockResolvedValueOnce(makeMission({ title: "SOL" }))
        .mockResolvedValueOnce(makeMission({ title: "SOL" }));
      mockRunTurnLoop.mockResolvedValueOnce({
        text: "ok", toolCallsMade: 0, pendingApprovals: [], stopReason: null,
      });

      await processMissionSetupTurn("session-1", "hi");

      const passedContext = mockRunTurnLoop.mock.calls[0][0] as { planMode?: boolean };
      expect(passedContext.planMode).toBe(false);
    });
  });
});
