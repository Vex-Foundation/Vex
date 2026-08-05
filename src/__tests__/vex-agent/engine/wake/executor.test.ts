/**
 * Wake executor unit tests. Exercises the pure `tick` function with injected
 * `WakeDeps` so we never load the DB client. Covers:
 *   - mission_run claims that resume (CAS + banner + resume call),
 *   - skip-stale-status re-check (preemption won the race),
 *   - skip-missing-mission-run guard,
 *   - error isolation (one row's failure doesn't poison the batch).
 *
 * Phase 2 collapse removed the `full_autonomous` wake kind; every wake now
 * targets a mission run.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Puzzle 3 atomic lease helpers — `wake/executor.ts` dynamically imports
// `claimRunLeaseAndFlipToRunning` instead of the previous `casFlipToRunning`
// dep. Tests inject `WakeDeps` for the public surface; the lease helper
// imports below cover the private dynamic-import path so they never hit
// the real `withTransaction` → `getPool().connect()` (which would
// ECONNREFUSED at 127.0.0.1:5777 in the test environment).
const mockClaimRunLeaseAndFlipToRunning = vi.fn();
const mockClaimRunForAutoRetry = vi.fn();
const mockClaimSessionLease = vi.fn();
const mockScheduleAgentSessionContinuation = vi.fn();
const mockAppendEngineMessage = vi.fn();

vi.mock("@vex-agent/engine/core/runner/runtime-continuation.js", () => ({
  scheduleAgentSessionContinuation: (...a: unknown[]) =>
    mockScheduleAgentSessionContinuation(...a),
}));

vi.mock("@vex-agent/engine/events/index.js", () => ({
  appendEngineMessage: (...a: unknown[]) => mockAppendEngineMessage(...a),
  appendMessage: vi.fn(),
  emitTranscriptAppend: vi.fn(),
}));
const mockReleaseLease = vi.fn().mockResolvedValue(undefined);
const mockCreateLeaseHandle = vi.fn();

vi.mock("@vex-agent/engine/runtime/lease-and-status.js", () => ({
  claimRunLeaseAndFlipToRunning: (...a: unknown[]) => mockClaimRunLeaseAndFlipToRunning(...a),
  claimRunForAutoRetry: (...a: unknown[]) => mockClaimRunForAutoRetry(...a),
  claimSessionLease: (...a: unknown[]) => mockClaimSessionLease(...a),
  observeAndApplyControl: vi.fn().mockResolvedValue({ outcome: "no_request" }),
}));

vi.mock("@vex-agent/engine/runtime/lease-handle.js", () => ({
  createLeaseHandle: (...a: unknown[]) => mockCreateLeaseHandle(...a),
}));

vi.mock("@vex-agent/engine/runtime/release-and-emit.js", () => ({
  releaseLeaseAndEmitControlState: (...a: unknown[]) => mockReleaseLease(...a),
}));

import { tick, isWakeProviderConfigured, type WakeDeps } from "../../../../vex-agent/engine/wake/executor.js";
import { backoffDelayMs } from "../../../../vex-agent/engine/wake/executor/claim-session-wake.js";
import type { LoopWakeRequest } from "../../../../vex-agent/db/repos/loop-wake.js";
import type { MissionRun } from "../../../../vex-agent/db/repos/mission-runs.js";

function makeStubLease(missionRunId: string | null = "run-1") {
  return {
    sessionId: "sess-1",
    missionRunId,
    ownerId: "test-owner",
    processKind: "electron_main" as const,
    acquiredAt: new Date(),
    heartbeatAt: new Date(),
    expiresAt: new Date(),
  };
}

function makeWake(overrides: Partial<LoopWakeRequest> = {}): LoopWakeRequest {
  return {
    id: "wake-1",
    sessionId: "sess-1",
    missionRunId: "run-1",
    dueAt: "2026-04-20T12:00:00.000Z",
    status: "consumed",
    reason: "continue monitoring",
    payload: null,
    createdAt: "2026-04-20T11:59:00.000Z",
    consumedAt: "2026-04-20T12:00:01.000Z",
    cancelledAt: null,
    cancelledReason: null,
    ...overrides,
  };
}

function makeRun(overrides: Partial<MissionRun> = {}): MissionRun {
  return {
    id: "run-1",
    missionId: "mission-1",
    sessionId: "sess-1",
    status: "paused_wake",
    startedAt: "2026-04-20T10:00:00.000Z",
    endedAt: null,
    lastCheckpointAt: null,
    stopReason: "waiting_for_wake",
    stopSummary: null,
    stopEvidenceJson: null,
    iterationCount: 3,
    contractSnapshotJson: null,
    recoveredFromRunId: null,
    errorRetryCount: 0,
    autoRetryUnsafe: false,
    ...overrides,
  };
}

function makeDeps(overrides: Partial<WakeDeps> = {}): WakeDeps {
  return {
    claimDue: vi.fn().mockResolvedValue([]),
    listDueSessionWakes: vi.fn().mockResolvedValue([]),
    claimSessionWake: vi.fn().mockResolvedValue({
      kind: "claimed",
      lease: makeStubLease(null),
    }),
    getMissionRun: vi.fn().mockResolvedValue(null),
    casFlipToRunning: vi.fn().mockResolvedValue("paused_wake"),
    injectWakeBanner: vi.fn().mockResolvedValue(undefined),
    resumeMissionRun: vi.fn().mockResolvedValue(undefined),
    continueAgentSession: vi.fn().mockResolvedValue(undefined),
    isProviderReady: vi.fn(() => true),
    ...overrides,
  };
}

describe("wake.executor.tick", () => {
  beforeEach(() => {
    mockClaimRunLeaseAndFlipToRunning.mockReset();
    // Default: atomic claim succeeds with previousStatus=paused_wake (wake
    // executor only ever calls the helper after observing paused_wake).
    mockClaimRunLeaseAndFlipToRunning.mockResolvedValue({
      outcome: "claimed",
      previousStatus: "paused_wake",
      lease: makeStubLease(),
      wakeCancelledCount: 1,
    });
    mockCreateLeaseHandle.mockReset();
    mockCreateLeaseHandle.mockReturnValue({
      lease: makeStubLease(),
      ownerId: "test-owner",
      release: vi.fn().mockResolvedValue(undefined),
      onLeaseLost: vi.fn(),
    });
    mockReleaseLease.mockReset();
    mockReleaseLease.mockResolvedValue(undefined);
    mockClaimRunForAutoRetry.mockReset();
    mockClaimSessionLease.mockReset();
    mockClaimSessionLease.mockResolvedValue({
      outcome: "claimed",
      lease: makeStubLease(null),
    });
    mockScheduleAgentSessionContinuation.mockReset();
    mockScheduleAgentSessionContinuation.mockResolvedValue({
      scheduled: true,
      dueAt: "2026-04-20T12:00:05.000Z",
    });
    mockAppendEngineMessage.mockReset();
    mockAppendEngineMessage.mockResolvedValue(undefined);
  });

  // ── Session-scoped agent continuation (no mission run row) ───────
  //
  // The trap this covers: the executor claims by RUN STATUS, and a
  // Full-Autonomous agent session has no run row at all. A wake row with
  // `missionRunId: null` must take the session-lease claim path and must never
  // reach `getMissionRun` (which would report `skipped_mission_run_missing`
  // and silently drop the continuation).
  describe("agent-session wakes", () => {
    const agentWake = () =>
      makeWake({
        id: "wake-agent-1",
        missionRunId: null,
        status: "pending",
        reason: "iteration_limit: runtime slice exhausted; continue autonomously",
        payload: { trigger: "iteration_limit", automatic: true },
      });

    /**
     * The batch `claimDue` is destructive. A session-scoped row must therefore
     * never travel through it: it is LISTED, then claimed atomically under the
     * session control lock. If this routing regresses, the consume→claim window
     * comes back and with it the "nothing to stop" hole.
     */
    it("is listed, never consumed by the destructive batch claim", async () => {
      const deps = makeDeps({
        listDueSessionWakes: vi.fn().mockResolvedValue([agentWake()]),
      });
      const now = new Date("2026-04-20T12:00:01.000Z");

      await tick(now, 10, deps);

      expect(deps.claimDue).toHaveBeenCalledWith(now, 10);
      expect(deps.listDueSessionWakes).toHaveBeenCalledWith(now, 10);
      expect(deps.claimSessionWake).toHaveBeenCalledWith(
        expect.objectContaining({
          ownerId: "wake-executor-wake-agent-1",
          now,
        }),
      );
    });

    it("continues the session under the atomic claim, never a run claim", async () => {
      const deps = makeDeps({
        listDueSessionWakes: vi.fn().mockResolvedValue([agentWake()]),
      });

      const results = await tick(new Date("2026-04-20T12:00:01.000Z"), 10, deps);

      expect(results[0]!.outcome).toEqual({
        kind: "agent_session_continued",
        sessionId: "sess-1",
      });
      expect(deps.getMissionRun).not.toHaveBeenCalled();
      expect(mockClaimRunLeaseAndFlipToRunning).not.toHaveBeenCalled();
      expect(deps.resumeMissionRun).not.toHaveBeenCalled();
      expect(deps.injectWakeBanner).toHaveBeenCalledWith(
        "sess-1",
        "iteration_limit: runtime slice exhausted; continue autonomously",
        "2026-04-20T12:00:00.000Z",
      );
      // The EXACT lease the executor claimed reaches the slice — the slice's
      // turn loop can only apply a prepared compaction by proving ownership.
      expect(deps.continueAgentSession).toHaveBeenCalledWith(
        "sess-1",
        "wake-executor-wake-agent-1",
      );
    });

    it("banner precedes the continuation, and the lease is always released", async () => {
      const deps = makeDeps({
        listDueSessionWakes: vi.fn().mockResolvedValue([agentWake()]),
      });

      await tick(new Date(), 10, deps);

      expect(deps.injectWakeBanner).toHaveBeenCalledBefore(
        deps.continueAgentSession as never,
      );
      expect(mockReleaseLease).toHaveBeenCalledWith(
        expect.anything(),
        "sess-1",
      );
    });

    /**
     * The lease holder is NOT necessarily the continuation — approval resume
     * and the end-of-turn hook take it too. Nothing is consumed on a busy
     * lease: the SAME row keeps the park, with a pushed-out due time.
     */
    it("DEFERS the same row instead of dropping when the session lease is busy", async () => {
      const deps = makeDeps({
        listDueSessionWakes: vi.fn().mockResolvedValue([agentWake()]),
        claimSessionWake: vi.fn().mockResolvedValue({
          kind: "lease_busy",
          attempt: 1,
          dueAt: "2026-04-20T12:00:06.000Z",
        }),
      });

      const results = await tick(new Date(), 10, deps);

      expect(results[0]?.outcome).toEqual({
        kind: "deferred_lease_busy",
        sessionId: "sess-1",
        attempt: 1,
        dueAt: "2026-04-20T12:00:06.000Z",
      });
      // No work was started against a session someone else is driving.
      expect(deps.injectWakeBanner).not.toHaveBeenCalled();
      expect(deps.continueAgentSession).not.toHaveBeenCalled();
      // The deleted replacement-row path must not come back.
      expect(mockScheduleAgentSessionContinuation).not.toHaveBeenCalled();
    });

    /**
     * A candidate is not a claim. Between the non-destructive list and the
     * locked revalidation an operator Stop can cancel the row — the executor
     * must then start nothing at all.
     */
    it("starts nothing when the row stopped being claimable under the lock", async () => {
      const deps = makeDeps({
        listDueSessionWakes: vi.fn().mockResolvedValue([agentWake()]),
        claimSessionWake: vi.fn().mockResolvedValue({ kind: "not_claimable" }),
      });

      const results = await tick(new Date(), 10, deps);

      expect(results[0]?.outcome).toEqual({ kind: "skipped_claim_lost" });
      expect(deps.injectWakeBanner).not.toHaveBeenCalled();
      expect(deps.continueAgentSession).not.toHaveBeenCalled();
    });

    /**
     * The backoff POLICY survived the protocol change verbatim: 5 s base,
     * doubling, 60 s cap — and NO attempt ceiling. A cap is a terminal ceiling
     * by another name, and under full autonomy there are no ceilings. Only the
     * DELAY is bounded; the one-pending-row-per-session index is what stops an
     * unbounded retry from growing the queue.
     */
    it("preserves the bounded-delay / unbounded-attempts backoff policy", () => {
      expect(backoffDelayMs(1)).toBe(5_000);
      expect(backoffDelayMs(2)).toBe(10_000);
      expect(backoffDelayMs(4)).toBe(40_000);
      expect(backoffDelayMs(10)).toBe(60_000);
      expect(backoffDelayMs(501)).toBe(60_000);
    });

    it("releases the lease when the continuation throws", async () => {
      const deps = makeDeps({
        listDueSessionWakes: vi.fn().mockResolvedValue([agentWake()]),
        continueAgentSession: vi.fn().mockRejectedValue(new Error("provider down")),
      });

      const results = await tick(new Date(), 10, deps);

      expect(results[0]!.outcome).toEqual({
        kind: "error",
        message: "provider down",
      });
      expect(mockReleaseLease).toHaveBeenCalled();
    });
  });

  // ── Phase 4d: error_retry wakes ──────────────────────────────────
  describe("auto-retry wakes", () => {
    const autoWake = () =>
      makeWake({ id: "wake-9", payload: { trigger: "error_retry", attempt: 2 } });

    it("resumes a paused_error run through the auto-retry claim", async () => {
      mockClaimRunForAutoRetry.mockResolvedValue({ outcome: "claimed", lease: makeStubLease() });
      const deps = makeDeps({
        claimDue: vi.fn().mockResolvedValue([autoWake()]),
        getMissionRun: vi.fn().mockResolvedValue(makeRun({ status: "paused_error" })),
      });

      const results = await tick(new Date(), 10, deps);

      expect(results[0]!.outcome).toEqual({ kind: "resumed", runId: "run-1" });
      // Routed to the auto-retry claim with the payload attempt — NOT the
      // paused_wake helper.
      expect(mockClaimRunForAutoRetry).toHaveBeenCalledWith(
        expect.objectContaining({ missionRunId: "run-1", expectedAttempt: 2 }),
      );
      expect(mockClaimRunLeaseAndFlipToRunning).not.toHaveBeenCalled();
      expect(deps.resumeMissionRun).toHaveBeenCalledWith(
        "run-1",
        "auto-retry-wake-9",
      );
    });

    it("CONSUMED-WAKE RACE: a human Recover stamped unsafe → claim ineligible → skip, no resume", async () => {
      // The wake was consumed by claimDue; meanwhile a human Recover mutated and
      // stamped the run unsafe, then it fell back to paused_error. The atomic
      // claim re-check rejects it.
      mockClaimRunForAutoRetry.mockResolvedValue({ outcome: "ineligible", reason: "unsafe" });
      const deps = makeDeps({
        claimDue: vi.fn().mockResolvedValue([autoWake()]),
        getMissionRun: vi.fn().mockResolvedValue(makeRun({ status: "paused_error" })),
      });

      const results = await tick(new Date(), 10, deps);

      expect(results[0]?.outcome).toEqual({ kind: "skipped_claim_lost" });
      expect(deps.resumeMissionRun).not.toHaveBeenCalled();
    });

    it("skips (no claim) when the run already moved off paused_error", async () => {
      const deps = makeDeps({
        claimDue: vi.fn().mockResolvedValue([autoWake()]),
        getMissionRun: vi.fn().mockResolvedValue(makeRun({ status: "running" })),
      });

      const results = await tick(new Date(), 10, deps);

      expect(results[0]!.outcome).toEqual({
        kind: "skipped_stale_status",
        currentStatus: "running",
      });
      expect(mockClaimRunForAutoRetry).not.toHaveBeenCalled();
      expect(deps.resumeMissionRun).not.toHaveBeenCalled();
    });
  });

  it("resumes a paused_wake mission run only after atomic claim", async () => {
    const wake = makeWake();
    const run = makeRun();
    const deps = makeDeps({
      claimDue: vi.fn().mockResolvedValue([wake]),
      getMissionRun: vi.fn().mockResolvedValue(run),
    });

    const results = await tick(new Date("2026-04-20T12:00:01.000Z"), 10, deps);

    expect(results).toHaveLength(1);
    expect(results[0]!.outcome).toEqual({ kind: "resumed", runId: "run-1" });
    // Puzzle 3: production migrated from `deps.casFlipToRunning` (non-atomic
    // CAS-then-lease) to the atomic `claimRunLeaseAndFlipToRunning` helper.
    expect(mockClaimRunLeaseAndFlipToRunning).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "sess-1",
        missionRunId: "run-1",
        fromStatuses: ["paused_wake"],
      }),
    );
    expect(mockClaimRunLeaseAndFlipToRunning).toHaveBeenCalledBefore(
      deps.injectWakeBanner as never,
    );
    expect(deps.injectWakeBanner).toHaveBeenCalledWith(
      "sess-1",
      "continue monitoring",
      "2026-04-20T12:00:00.000Z",
    );
    expect(deps.resumeMissionRun).toHaveBeenCalledWith(
      "run-1",
      "wake-executor-wake-1",
    );
  });

  it("skips when the run is no longer paused_wake (user preempt won the race)", async () => {
    const deps = makeDeps({
      claimDue: vi.fn().mockResolvedValue([makeWake()]),
      getMissionRun: vi.fn().mockResolvedValue(makeRun({ status: "running" })),
    });

    const results = await tick(new Date(), 10, deps);

    expect(results[0]!.outcome).toEqual({
      kind: "skipped_stale_status",
      currentStatus: "running",
    });
    expect(deps.injectWakeBanner).not.toHaveBeenCalled();
    expect(mockClaimRunLeaseAndFlipToRunning).not.toHaveBeenCalled();
    expect(deps.resumeMissionRun).not.toHaveBeenCalled();
  });

  it("skips banner and resume when the atomic claim loses to another resumer", async () => {
    mockClaimRunLeaseAndFlipToRunning.mockResolvedValueOnce({
      outcome: "status_mismatch",
      currentStatus: "running",
    });
    const deps = makeDeps({
      claimDue: vi.fn().mockResolvedValue([makeWake()]),
      getMissionRun: vi.fn().mockResolvedValue(makeRun()),
    });

    const results = await tick(new Date(), 10, deps);

    expect(results[0]!.outcome).toEqual({ kind: "skipped_claim_lost" });
    expect(deps.injectWakeBanner).not.toHaveBeenCalled();
    expect(deps.resumeMissionRun).not.toHaveBeenCalled();
  });

  it("skips when the mission run row has been deleted between claim and resume", async () => {
    const deps = makeDeps({
      claimDue: vi.fn().mockResolvedValue([makeWake()]),
      getMissionRun: vi.fn().mockResolvedValue(null),
    });

    const results = await tick(new Date(), 10, deps);

    expect(results[0]!.outcome).toEqual({ kind: "skipped_mission_run_missing" });
    expect(deps.resumeMissionRun).not.toHaveBeenCalled();
  });

  it("reports error outcome without poisoning the rest of the batch", async () => {
    const wakeA = makeWake({ id: "wake-a", missionRunId: "run-a" });
    const wakeB = makeWake({ id: "wake-b", missionRunId: "run-b" });
    const deps = makeDeps({
      claimDue: vi.fn().mockResolvedValue([wakeA, wakeB]),
      getMissionRun: vi.fn().mockImplementation((runId: string) => {
        if (runId === "run-a") throw new Error("db exploded");
        return Promise.resolve(makeRun({ id: "run-b" }));
      }),
    });

    const results = await tick(new Date(), 10, deps);

    expect(results).toHaveLength(2);
    expect(results[0]!.outcome).toEqual({ kind: "error", message: "db exploded" });
    expect(results[1]!.outcome).toEqual({ kind: "resumed", runId: "run-b" });
  });

  it("returns an empty array when claimDue yields no rows", async () => {
    const deps = makeDeps();
    const results = await tick(new Date(), 10, deps);
    expect(results).toEqual([]);
    expect(deps.injectWakeBanner).not.toHaveBeenCalled();
  });

  it("does NOT claim when provider config is absent (pre-claim gate)", async () => {
    // claimDue is destructive (pending→consumed); the gate must short-circuit
    // BEFORE it so a wake row is never consumed when the resume cannot run.
    const claimDue = vi.fn().mockResolvedValue([makeWake()]);
    const deps = makeDeps({ claimDue, isProviderReady: () => false });

    const results = await tick(new Date(), 10, deps);

    expect(results).toEqual([]);
    expect(claimDue).not.toHaveBeenCalled();
    expect(deps.resumeMissionRun).not.toHaveBeenCalled();
  });
});

describe("isWakeProviderConfigured", () => {
  const KEY = "OPENROUTER_API_KEY";
  const MODEL = "AGENT_MODEL";
  let savedKey: string | undefined;
  let savedModel: string | undefined;

  beforeEach(() => {
    savedKey = process.env[KEY];
    savedModel = process.env[MODEL];
  });

  afterEach(() => {
    if (savedKey === undefined) delete process.env[KEY];
    else process.env[KEY] = savedKey;
    if (savedModel === undefined) delete process.env[MODEL];
    else process.env[MODEL] = savedModel;
  });

  it("is true only when BOTH OPENROUTER_API_KEY and AGENT_MODEL are set", () => {
    process.env[KEY] = "sk-or-xxx";
    process.env[MODEL] = "anthropic/claude-sonnet-4.5";
    expect(isWakeProviderConfigured()).toBe(true);
  });

  it("is false when OPENROUTER_API_KEY is absent", () => {
    delete process.env[KEY];
    process.env[MODEL] = "anthropic/claude-sonnet-4.5";
    expect(isWakeProviderConfigured()).toBe(false);
  });

  it("is false when AGENT_MODEL is absent", () => {
    process.env[KEY] = "sk-or-xxx";
    delete process.env[MODEL];
    expect(isWakeProviderConfigured()).toBe(false);
  });
});
