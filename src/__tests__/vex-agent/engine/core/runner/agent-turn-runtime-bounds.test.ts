/**
 * Agent-turn runtime bounds — the permission-aware iteration budget, the
 * continuation an autonomous agent session gets when a bound is exhausted, and
 * the graceful reply that must never leave a turn silent.
 *
 * Three behaviours are pinned here, all of them money-adjacent because a Full
 * Autonomous session can be mid tool-sequence when a bound fires:
 *
 *   1. BUDGET. `permission: 'full'` gets 1000 iterations, `restricted` keeps
 *      50. One source of truth (`iteration-budget.ts`), asserted through the
 *      loop config the runner actually hands to `runTurnLoop`.
 *   2. CONTINUATION. A Full-Autonomous agent session that exhausts
 *      `iteration_limit` / `timeout` schedules a wake (counters reset by
 *      construction — the woken turn is a fresh `runTurnLoop`). A Restricted
 *      session schedules NOTHING and keeps today's one-shot behaviour.
 *   3. NO SILENT TURN. `timeout` used to be the hole: `agent.ts` special-cased
 *      only `iteration_limit`, so a Restricted agent that ran out of wall-clock
 *      returned `text: null` and the user saw an empty turn. Characterised
 *      first, then fixed.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ─────────────────────────────────────────────────────

const mockResolveProvider = vi.fn();
const mockAddMessage = vi.fn();
const mockAddEngineMessage = vi.fn();
const mockHydrate = vi.fn();
const mockRunTurnLoop = vi.fn();
const mockEnqueueWake = vi.fn();
const mockCancelWake = vi.fn();
const mockGetPendingWake = vi.fn();
const mockGateOnOperatorStop = vi.fn();
const mockWithSessionControlLock = vi.fn();

vi.mock("@vex-agent/inference/registry.js", () => ({
  resolveProvider: () => mockResolveProvider(),
}));

vi.mock("@vex-agent/engine/events/index.js", () => ({
  appendMessage: (...a: unknown[]) => mockAddMessage(...a),
  appendEngineMessage: (...a: unknown[]) => mockAddEngineMessage(...a),
  emitTranscriptAppend: vi.fn(),
}));

vi.mock("../../../../../vex-agent/engine/core/hydrate.js", () => ({
  hydrateEngineSession: (...a: unknown[]) => mockHydrate(...a),
}));

vi.mock("../../../../../vex-agent/engine/core/turn-loop.js", () => ({
  runTurnLoop: (...a: unknown[]) => mockRunTurnLoop(...a),
}));

vi.mock("@vex-agent/db/repos/loop-wake.js", () => ({
  enqueue: (...a: unknown[]) => mockEnqueueWake(...a),
  cancelForSession: (...a: unknown[]) => mockCancelWake(...a),
  getPendingForSession: (...a: unknown[]) => mockGetPendingWake(...a),
}));

vi.mock("@vex-agent/tools/registry.js", () => ({
  getOpenAITools: vi.fn().mockReturnValue([]),
}));

vi.mock("@utils/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@vex-agent/engine/runtime/lease-and-status.js", () => ({
  claimSessionLease: vi.fn().mockResolvedValue({
    outcome: "claimed",
    lease: {
      sessionId: "session-1",
      missionRunId: null,
      ownerId: "test-owner",
      processKind: "electron_main",
      acquiredAt: new Date(),
      heartbeatAt: new Date(),
      expiresAt: new Date(),
    },
  }),
  withSessionControlLock: (...a: unknown[]) => mockWithSessionControlLock(...a),
  gateOnOperatorStopWithClient: (...a: unknown[]) => mockGateOnOperatorStop(...a),
}));

vi.mock("@vex-agent/engine/runtime/lease-handle.js", () => ({
  createLeaseHandle: vi.fn().mockReturnValue({
    lease: {
      sessionId: "session-1",
      missionRunId: null,
      ownerId: "test-owner",
      processKind: "electron_main",
      acquiredAt: new Date(),
      heartbeatAt: new Date(),
      expiresAt: new Date(),
    },
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

const { processAgentTurn } = await import(
  "../../../../../vex-agent/engine/core/runner/agent.js"
);
const {
  ITERATION_LIMIT_REPLY,
  TIMEOUT_REPLY,
} = await import("../../../../../vex-agent/engine/core/runner/shared.js");
const {
  FULL_AUTONOMY_MAX_ITERATIONS,
  RESTRICTED_MAX_ITERATIONS,
  maxIterationsForPermission,
} = await import(
  "../../../../../vex-agent/engine/core/runner/iteration-budget.js"
);

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

function makeHydratedSession(permission: "restricted" | "full") {
  return {
    context: {
      sessionId: "session-1",
      sessionKind: "agent",
      sessionPermission: permission,
      missionId: null,
      missionRunId: null,
      loadedDocuments: new Map(),
    },
    messages: [],
    summary: null,
    tokenCount: 0,
  };
}

/** The loop config `processAgentTurn` handed to `runTurnLoop` (positional 8). */
function capturedLoopConfig(): { maxIterations: number } {
  const call = mockRunTurnLoop.mock.calls[0];
  if (call === undefined) throw new Error("runTurnLoop was never called");
  return call[7] as { maxIterations: number };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockResolveProvider.mockResolvedValue(makeProvider());
  mockHydrate.mockResolvedValue(makeHydratedSession("restricted"));
  mockAddMessage.mockResolvedValue(undefined);
  mockAddEngineMessage.mockResolvedValue(undefined);
  mockEnqueueWake.mockResolvedValue({
    id: "wake-1",
    sessionId: "session-1",
    missionRunId: null,
    dueAt: "2026-07-29T12:00:05.000Z",
    status: "pending",
    reason: null,
    payload: null,
    createdAt: "2026-07-29T12:00:00.000Z",
    consumedAt: null,
    cancelledAt: null,
    cancelledReason: null,
  });
  mockCancelWake.mockResolvedValue(1);
  mockGetPendingWake.mockResolvedValue(null);
  mockGateOnOperatorStop.mockResolvedValue({ kind: "clear" });
  // Run the locked body against a stub client, like the real helper does.
  mockWithSessionControlLock.mockImplementation(
    async (_sessionId: string, fn: (client: unknown) => Promise<unknown>) =>
      fn({ query: vi.fn() }),
  );
});

// ── 1. Permission-aware iteration budget ───────────────────────

describe("iteration budget — one source of truth", () => {
  it("maps permission to the budget in exactly one place", () => {
    expect(maxIterationsForPermission("full")).toBe(FULL_AUTONOMY_MAX_ITERATIONS);
    expect(maxIterationsForPermission("restricted")).toBe(RESTRICTED_MAX_ITERATIONS);
    expect(FULL_AUTONOMY_MAX_ITERATIONS).toBe(1000);
    expect(RESTRICTED_MAX_ITERATIONS).toBe(50);
  });

  it("a Full-Autonomous agent turn runs on the generous budget", async () => {
    mockHydrate.mockResolvedValue(makeHydratedSession("full"));
    mockRunTurnLoop.mockResolvedValue({
      text: "done", toolCallsMade: 3, pendingApprovals: [], stopReason: null,
    });

    await processAgentTurn("session-1", "go");

    expect(capturedLoopConfig().maxIterations).toBe(1000);
  });

  it("a Restricted agent turn keeps today's 50", async () => {
    mockRunTurnLoop.mockResolvedValue({
      text: "done", toolCallsMade: 3, pendingApprovals: [], stopReason: null,
    });

    await processAgentTurn("session-1", "go");

    expect(capturedLoopConfig().maxIterations).toBe(50);
  });
});

// ── 2. Continuation ────────────────────────────────────────────

describe("Full-Autonomous agent session continuation", () => {
  for (const trigger of ["iteration_limit", "timeout"] as const) {
    it(`schedules a session-scoped wake on ${trigger}`, async () => {
      mockHydrate.mockResolvedValue(makeHydratedSession("full"));
      mockRunTurnLoop.mockResolvedValue({
        text: null, toolCallsMade: 12, pendingApprovals: [], stopReason: trigger,
      });

      const result = await processAgentTurn("session-1", "go");

      expect(mockEnqueueWake).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: "session-1", missionRunId: null }),
        expect.anything(),
      );
      expect(result.stopReason).toBe(trigger);
      // The session continues — no user-visible "I gave up" paragraph.
      expect(mockAddMessage).not.toHaveBeenCalledWith(
        "session-1",
        expect.objectContaining({ role: "assistant" }),
        expect.anything(),
      );
    });
  }

  it("parks under the session control lock with the operator-stop gate", async () => {
    mockHydrate.mockResolvedValue(makeHydratedSession("full"));
    mockRunTurnLoop.mockResolvedValue({
      text: null, toolCallsMade: 12, pendingApprovals: [], stopReason: "iteration_limit",
    });

    await processAgentTurn("session-1", "go");

    expect(mockWithSessionControlLock).toHaveBeenCalledWith(
      "session-1",
      expect.any(Function),
    );
    expect(mockGateOnOperatorStop).toHaveBeenCalled();
  });

  /**
   * The enqueue and the stop decision commit TOGETHER. The old shape enqueued
   * first and compensated with a cancel, so a stop landing right after the
   * pre-sample left a live wake on a stopped session — the compensating write
   * raced the very thing it compensated for.
   */
  it("never inserts a row at all when the stop gate reports stopped", async () => {
    mockHydrate.mockResolvedValue(makeHydratedSession("full"));
    mockGateOnOperatorStop.mockResolvedValue({ kind: "stopped", runStatus: "stopped" });
    mockRunTurnLoop.mockResolvedValue({
      text: null, toolCallsMade: 12, pendingApprovals: [], stopReason: "iteration_limit",
    });

    const result = await processAgentTurn("session-1", "go");

    expect(mockEnqueueWake).not.toHaveBeenCalled();
    // Nothing to compensate for — no cancel write is issued.
    expect(mockCancelWake).not.toHaveBeenCalled();
    // No continuation → the turn must not be silent.
    expect(result.text).toBe(ITERATION_LIMIT_REPLY);
  });

  it("never inserts a row when the slice was cancelled mid-flight", async () => {
    mockHydrate.mockResolvedValue(makeHydratedSession("full"));
    const controller = new AbortController();
    controller.abort();
    mockRunTurnLoop.mockResolvedValue({
      text: null, toolCallsMade: 12, pendingApprovals: [], stopReason: "iteration_limit",
    });

    const result = await processAgentTurn("session-1", "go", controller.signal);

    expect(mockEnqueueWake).not.toHaveBeenCalled();
    expect(mockCancelWake).not.toHaveBeenCalled();
    expect(result.text).toBe(ITERATION_LIMIT_REPLY);
  });

  /**
   * The race blocker (c) named: a cancellation that lands AFTER any pre-sample
   * but BEFORE the insert. Modelled by aborting from inside the locked body,
   * i.e. between the gate and the enqueue — the exact window. The signal is
   * re-read inside the transaction, so no row is ever written.
   */
  it("cancellation racing the enqueue leaves no live wake", async () => {
    mockHydrate.mockResolvedValue(makeHydratedSession("full"));
    const controller = new AbortController();
    mockGateOnOperatorStop.mockImplementation(async () => {
      controller.abort();
      return { kind: "clear" };
    });
    mockRunTurnLoop.mockResolvedValue({
      text: null, toolCallsMade: 12, pendingApprovals: [], stopReason: "iteration_limit",
    });

    await processAgentTurn("session-1", "go", controller.signal);

    expect(mockEnqueueWake).not.toHaveBeenCalled();
    expect(mockCancelWake).not.toHaveBeenCalled();
  });

  it("enqueues inside the locked transaction, not on the pool", async () => {
    mockHydrate.mockResolvedValue(makeHydratedSession("full"));
    mockRunTurnLoop.mockResolvedValue({
      text: null, toolCallsMade: 12, pendingApprovals: [], stopReason: "iteration_limit",
    });

    await processAgentTurn("session-1", "go");

    // Second argument is the locked client — that is what makes the decision
    // and the INSERT one transaction.
    expect(mockEnqueueWake).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "session-1", missionRunId: null }),
      expect.objectContaining({ query: expect.anything() }),
    );
  });

  it("a Restricted agent session schedules NOTHING", async () => {
    mockRunTurnLoop.mockResolvedValue({
      text: null, toolCallsMade: 50, pendingApprovals: [], stopReason: "iteration_limit",
    });

    const result = await processAgentTurn("session-1", "go");

    expect(mockEnqueueWake).not.toHaveBeenCalled();
    expect(result.text).toBe(ITERATION_LIMIT_REPLY);
  });
});

// ── 3. No silent turn (the characterised bug) ──────────────────

describe("timeout must not produce a silent turn", () => {
  it("Restricted agent: timeout persists an honest wall-clock reply", async () => {
    mockRunTurnLoop.mockResolvedValue({
      text: null, toolCallsMade: 7, pendingApprovals: [], stopReason: "timeout",
    });

    const result = await processAgentTurn("session-1", "go");

    expect(result.text).toBe(TIMEOUT_REPLY);
    expect(result.stopReason).toBe("timeout");
    expect(mockAddMessage).toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({ role: "assistant", content: TIMEOUT_REPLY }),
      expect.objectContaining({
        source: "assistant",
        messageType: "chat",
        visibility: "user",
      }),
    );
  });

  it("the timeout reply names the bound, not a tool-use budget", () => {
    expect(TIMEOUT_REPLY).not.toBe(ITERATION_LIMIT_REPLY);
    expect(TIMEOUT_REPLY).toMatch(/time/i);
  });

  it("a partial reply is preserved on timeout (no synthesis)", async () => {
    mockRunTurnLoop.mockResolvedValue({
      text: "Partial progress.", toolCallsMade: 7, pendingApprovals: [], stopReason: "timeout",
    });

    const result = await processAgentTurn("session-1", "go");

    expect(result.text).toBe("Partial progress.");
    expect(mockAddMessage).not.toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({ content: TIMEOUT_REPLY }),
      expect.anything(),
    );
  });
});

/**
 * FOREGROUND STOP after a COMMITTED park.
 *
 * The foreground Stop is deliberately request-local: it aborts the IPC request
 * and writes nothing durable. That was correct while a turn could only be
 * generating text. It stopped being correct once the model could park the
 * session mid-turn — `loop_defer` commits a pending wake, the batch tears down,
 * the turn returns, and the operator's Stop had cancelled a request while
 * leaving a live continuation behind. The executor then started a fresh
 * autonomous slice moments later: the user pressed Stop and the agent kept
 * going.
 */
describe("foreground stop — committed-wake cleanup", () => {
  function abortedSignal(): AbortSignal {
    const controller = new AbortController();
    controller.abort();
    return controller.signal;
  }

  it("cancels the session-scoped park the stopped turn committed", async () => {
    mockHydrate.mockResolvedValue(makeHydratedSession("full"));
    mockRunTurnLoop.mockResolvedValue({
      text: null,
      toolCallsMade: 3,
      pendingApprovals: [],
      stopReason: "waiting_for_wake",
    });
    const statements: string[] = [];
    mockWithSessionControlLock.mockImplementation(
      async (_sessionId: string, fn: (client: unknown) => Promise<unknown>) =>
        fn({
          query: vi.fn(async (sql: string) => {
            statements.push(sql);
            return { rows: [], rowCount: 1 };
          }),
        }),
    );

    await processAgentTurn("session-1", "go", abortedSignal());

    const cancels = statements.filter((sql) =>
      sql.includes("UPDATE loop_wake_requests")
      && sql.includes("consumed_by_foreground_stop"),
    );
    expect(cancels).toHaveLength(1);
    // Scoped to the SESSION park only — a mission's park belongs to its run
    // row and its own stop path, and is not this turn's to cancel.
    expect(cancels[0]).toContain("mission_run_id IS NULL");
    expect(cancels[0]).toContain("status         = 'pending'");
  });

  it("does NOT cancel anything when the turn was not stopped", async () => {
    mockHydrate.mockResolvedValue(makeHydratedSession("full"));
    mockRunTurnLoop.mockResolvedValue({
      text: "done",
      toolCallsMade: 0,
      pendingApprovals: [],
      stopReason: null,
    });
    const statements: string[] = [];
    mockWithSessionControlLock.mockImplementation(
      async (_sessionId: string, fn: (client: unknown) => Promise<unknown>) =>
        fn({
          query: vi.fn(async (sql: string) => {
            statements.push(sql);
            return { rows: [], rowCount: 0 };
          }),
        }),
    );

    await processAgentTurn("session-1", "go");

    expect(
      statements.filter((sql) => sql.includes("consumed_by_foreground_stop")),
    ).toHaveLength(0);
  });

  /**
   * Best-effort by contract: the turn's own outcome is what the caller needs,
   * and the durable Stop path stays available. A cleanup failure must never
   * mask the result.
   */
  it("never masks the turn outcome when the cleanup fails", async () => {
    mockHydrate.mockResolvedValue(makeHydratedSession("full"));
    mockRunTurnLoop.mockResolvedValue({
      text: "partial",
      toolCallsMade: 1,
      pendingApprovals: [],
      stopReason: "waiting_for_wake",
    });
    mockWithSessionControlLock.mockRejectedValue(new Error("db down"));

    const result = await processAgentTurn("session-1", "go", abortedSignal());

    expect(result.text).toBe("partial");
  });
});
