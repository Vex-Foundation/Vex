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
 *   4. STALL. `no_progress` is a FOURTH bound with different semantics from all
 *      three above: it is not a budget, it is never continued (not even under
 *      full autonomy), and it carries its own copy. The v0.2.6 report is the
 *      reason it exists - fifty rounds that produced nothing, apologised for
 *      with an "I reached my tool-use budget" paragraph that was false.
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
  NO_PROGRESS_REPLY,
  TOOL_CALL_LOOP_REPLY,
} = await import("../../../../../vex-agent/engine/core/runner/shared.js");
const { MAX_CONSECUTIVE_UNPRODUCTIVE_ROUNDS } = await import(
  "../../../../../vex-agent/engine/core/runner/unproductive-rounds.js"
);
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
      // M2 contract change: a SUCCESSFULLY continued full-autonomy turn
      // reports `waiting_for_wake`, not the raw slice guard. The guard names
      // what fired inside the turn; the stop reason is read downstream as an
      // account of how the turn ENDED, and this one ended parked on a live
      // wake the executor resumes in seconds. Reporting `timeout` here is what
      // made the composer render a terminal failure banner over work that was
      // still running. The raw guard is still reported everywhere else - see
      // the restricted-session and scheduling-failure cases below.
      expect(result.stopReason).toBe("waiting_for_wake");
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

// ── 4. Model stall (`no_progress`) ─────────────────────────────

describe("a stalled model is never continued and never silent", () => {
  it("Restricted agent: persists the stall reply, not the budget apology", async () => {
    mockRunTurnLoop.mockResolvedValue({
      text: null, toolCallsMade: 0, pendingApprovals: [], stopReason: "no_progress",
    });

    const result = await processAgentTurn("session-1", "go");

    expect(result.text).toBe(NO_PROGRESS_REPLY);
    expect(result.stopReason).toBe("no_progress");
    expect(mockAddMessage).toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({ role: "assistant", content: NO_PROGRESS_REPLY }),
      expect.objectContaining({
        source: "assistant",
        messageType: "chat",
        visibility: "user",
      }),
    );
  });

  // THE regression the v0.2.6 report is about. Reusing `ITERATION_LIMIT_REPLY`
  // here would tell the user a tool-use budget was exhausted when zero tools
  // ran, and would invite them to say "continue" - buying another run of empty
  // rounds. Same refusal `TIMEOUT_REPLY` was created for.
  it("the stall reply is its own copy and never claims a budget was spent", () => {
    expect(NO_PROGRESS_REPLY).not.toBe(ITERATION_LIMIT_REPLY);
    expect(NO_PROGRESS_REPLY).not.toBe(TIMEOUT_REPLY);
    expect(NO_PROGRESS_REPLY).not.toMatch(/budget/i);
    expect(NO_PROGRESS_REPLY).toMatch(/empty responses/i);
    // The count is derived from the bound, so the sentence cannot drift.
    expect(NO_PROGRESS_REPLY).toContain(String(MAX_CONSECUTIVE_UNPRODUCTIVE_ROUNDS));
  });

  // The reply must not promise a clean slate: the stall is only the TAIL of the
  // turn, and rounds before it can have moved real funds.
  it("the stall reply never claims nothing ran", () => {
    expect(NO_PROGRESS_REPLY).not.toMatch(/nothing was executed/i);
    expect(NO_PROGRESS_REPLY).toMatch(/transcript/i);
  });

  it("a FULL-AUTONOMY session schedules NOTHING on a stall", async () => {
    // The decisive difference from `iteration_limit`. An unproductive round
    // persists nothing, so a woken slice re-sends the identical request and
    // stalls identically - a wake loop that spends input tokens forever.
    mockHydrate.mockResolvedValue(makeHydratedSession("full"));
    mockRunTurnLoop.mockResolvedValue({
      text: null, toolCallsMade: 0, pendingApprovals: [], stopReason: "no_progress",
    });

    const result = await processAgentTurn("session-1", "go");

    expect(mockEnqueueWake).not.toHaveBeenCalled();
    expect(result.text).toBe(NO_PROGRESS_REPLY);
  });

  it("a partial reply is preserved on a stall (no synthesis)", async () => {
    mockRunTurnLoop.mockResolvedValue({
      text: "Partial progress.", toolCallsMade: 2, pendingApprovals: [], stopReason: "no_progress",
    });

    const result = await processAgentTurn("session-1", "go");

    expect(result.text).toBe("Partial progress.");
    expect(mockAddMessage).not.toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({ content: NO_PROGRESS_REPLY }),
      expect.anything(),
    );
  });

  it("the stall bound is far below the iteration budget it must pre-empt", () => {
    // If these ever converge the detector stops being a stall detector and
    // becomes a second budget - the exact conflation this work separated.
    expect(MAX_CONSECUTIVE_UNPRODUCTIVE_ROUNDS).toBeLessThan(
      RESTRICTED_MAX_ITERATIONS,
    );
    expect(MAX_CONSECUTIVE_UNPRODUCTIVE_ROUNDS).toBe(3);
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

// ── 5. M2: the reported stop reason is an account of the TURN ──

/**
 * `stopReason` is read downstream as "how did this turn end". For a
 * successfully continued full-autonomy turn the honest answer is
 * `waiting_for_wake`, not the slice guard that fired inside it - the composer
 * renders a terminal failure banner for `timeout`, exports record it as the
 * ending, bug reports classify on it, and none of those are true of a turn the
 * executor is about to resume.
 *
 * The remap is NARROW, and the tests below are what keeps it narrow. Every
 * path that does NOT actually leave a live wake behind must keep the raw
 * guard, because promising a resume nothing will perform is the same
 * dishonesty pointed the other way.
 */
describe("M2 - only a CONTINUED full-autonomy turn reports waiting_for_wake", () => {
  for (const trigger of ["iteration_limit", "timeout"] as const) {
    it(`a RESTRICTED session keeps the raw ${trigger} - it was never continued`, async () => {
      mockHydrate.mockResolvedValue(makeHydratedSession("restricted"));
      mockRunTurnLoop.mockResolvedValue({
        text: null, toolCallsMade: 4, pendingApprovals: [], stopReason: trigger,
      });

      const result = await processAgentTurn("session-1", "go");

      expect(mockEnqueueWake).not.toHaveBeenCalled();
      expect(result.stopReason).toBe(trigger);
      expect(result.text).toBe(
        trigger === "timeout" ? TIMEOUT_REPLY : ITERATION_LIMIT_REPLY,
      );
    });
  }

  it("a full-autonomy turn whose SCHEDULING FAILED keeps the raw guard", async () => {
    // The operator stopped the session while the slice was unwinding, so the
    // gate refuses and no wake row exists. Nothing is going to resume this.
    mockHydrate.mockResolvedValue(makeHydratedSession("full"));
    mockGateOnOperatorStop.mockResolvedValue({ kind: "stopped", runStatus: "stopped" });
    mockRunTurnLoop.mockResolvedValue({
      text: null, toolCallsMade: 12, pendingApprovals: [], stopReason: "timeout",
    });

    const result = await processAgentTurn("session-1", "go");

    expect(mockEnqueueWake).not.toHaveBeenCalled();
    expect(result.stopReason).toBe("timeout");
    expect(result.text).toBe(TIMEOUT_REPLY);
  });

  it("a stall is never remapped - no_progress is not continued under any permission", async () => {
    mockHydrate.mockResolvedValue(makeHydratedSession("full"));
    mockRunTurnLoop.mockResolvedValue({
      text: null, toolCallsMade: 0, pendingApprovals: [], stopReason: "no_progress",
    });

    const result = await processAgentTurn("session-1", "go");

    expect(mockEnqueueWake).not.toHaveBeenCalled();
    expect(result.stopReason).toBe("no_progress");
    expect(result.text).toBe(NO_PROGRESS_REPLY);
  });
});

// ── 6. M4: the tool-call repetition arm, beside the stall arm ──

describe("tool_call_loop - the agent-session synthesis arm", () => {
  it("synthesises the repetition reply and schedules NOTHING, even under full autonomy", async () => {
    // The decisive property. Waking a session that just proved it repeats
    // itself schedules the repetition; the reply must also be the repetition
    // one, not the stall one - they describe opposite things about what ran.
    mockHydrate.mockResolvedValue(makeHydratedSession("full"));
    mockRunTurnLoop.mockResolvedValue({
      text: null, toolCallsMade: 6, pendingApprovals: [], stopReason: "tool_call_loop",
    });

    const result = await processAgentTurn("session-1", "go");

    expect(mockEnqueueWake).not.toHaveBeenCalled();
    expect(result.stopReason).toBe("tool_call_loop");
    expect(result.text).toBe(TOOL_CALL_LOOP_REPLY);
    expect(result.text).not.toBe(NO_PROGRESS_REPLY);
  });

  it("preserves partial model text instead of overwriting it with the canned reply", async () => {
    mockHydrate.mockResolvedValue(makeHydratedSession("full"));
    mockRunTurnLoop.mockResolvedValue({
      text: "Here is what I found before I got stuck.",
      toolCallsMade: 6,
      pendingApprovals: [],
      stopReason: "tool_call_loop",
    });

    const result = await processAgentTurn("session-1", "go");

    expect(result.text).toBe("Here is what I found before I got stuck.");
    expect(mockAddMessage).not.toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({ content: TOOL_CALL_LOOP_REPLY }),
      expect.anything(),
    );
  });
});
