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
const mockReleaseLease = vi.fn().mockResolvedValue(undefined);
const mockCreateLeaseHandle = vi.fn();

vi.mock("@vex-agent/engine/runtime/lease-and-status.js", () => ({
  claimRunLeaseAndFlipToRunning: (...a: unknown[]) => mockClaimRunLeaseAndFlipToRunning(...a),
  claimRunForAutoRetry: (...a: unknown[]) => mockClaimRunForAutoRetry(...a),
  claimSessionLease: vi.fn(),
  observeAndApplyControl: vi.fn().mockResolvedValue({ outcome: "no_request" }),
}));

vi.mock("@vex-agent/engine/runtime/lease-handle.js", () => ({
  createLeaseHandle: (...a: unknown[]) => mockCreateLeaseHandle(...a),
}));

vi.mock("@vex-agent/engine/runtime/release-and-emit.js", () => ({
  releaseLeaseAndEmitControlState: (...a: unknown[]) => mockReleaseLease(...a),
}));

import { tick, isWakeProviderConfigured, type WakeDeps } from "../../../../vex-agent/engine/wake/executor.js";
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
    ...overrides,
  };
}

function makeDeps(overrides: Partial<WakeDeps> = {}): WakeDeps {
  return {
    claimDue: vi.fn().mockResolvedValue([]),
    getMissionRun: vi.fn().mockResolvedValue(null),
    casFlipToRunning: vi.fn().mockResolvedValue("paused_wake"),
    injectWakeBanner: vi.fn().mockResolvedValue(undefined),
    resumeMissionRun: vi.fn().mockResolvedValue(undefined),
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
      signal: new AbortController().signal,
    });
    mockReleaseLease.mockReset();
    mockReleaseLease.mockResolvedValue(undefined);
    mockClaimRunForAutoRetry.mockReset();
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
        expect.any(AbortSignal),
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

      expect(results[0]!.outcome).toEqual({ kind: "skipped_claim_lost" });
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
      expect.any(AbortSignal),
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
