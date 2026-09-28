/**
 * Wake executor unit tests. Exercises the pure `tick` function with injected
 * `WakeDeps` so we never load the DB client. Covers:
 *   - mission-run wakes claimed ONE AT A TIME through the atomic claim, then
 *     banner + resume under the claimed lease,
 *   - every non-claimed outcome (deferred, dropped, not claimable) starting
 *     nothing,
 *   - error isolation (one row's failure doesn't poison the batch),
 *   - the session-scoped path, which never touches the mission claim.
 *
 * The claim itself (locks, one transaction, crash atomicity) is proved against
 * real Postgres in `integration/engine/mission-wake-claim.int.test.ts`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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

vi.mock("@vex-agent/engine/runtime/lease-handle.js", () => ({
  createLeaseHandle: (...a: unknown[]) => mockCreateLeaseHandle(...a),
}));

vi.mock("@vex-agent/engine/runtime/release-and-emit.js", () => ({
  releaseLeaseAndEmitControlState: (...a: unknown[]) => mockReleaseLease(...a),
}));

import { tick, isWakeProviderConfigured, type WakeDeps } from "../../../../vex-agent/engine/wake/executor.js";
import { backoffDelayMs } from "../../../../vex-agent/engine/wake/executor/claim-session-wake.js";
import type {
  ClaimMissionWakeInput,
  ClaimMissionWakeOutcome,
} from "../../../../vex-agent/engine/wake/executor/claim-mission-wake.js";
import type { LoopWakeRequest } from "../../../../vex-agent/db/repos/loop-wake.js";
import type { RunnerLease } from "../../../../vex-agent/db/repos/runner-leases.js";
import { requireValue } from "../../../helpers/require-value.js";

function makeStubLease(missionRunId: string | null = "run-1"): RunnerLease {
  return {
    sessionId: "sess-1",
    missionRunId,
    ownerId: "test-owner",
    processKind: "electron_main",
    acquiredAt: new Date(),
    heartbeatAt: new Date(),
    expiresAt: new Date(),
    claimToken: "token-1",
  };
}

function makeWake(overrides: Partial<LoopWakeRequest> = {}): LoopWakeRequest {
  return {
    id: "wake-1",
    sessionId: "sess-1",
    missionRunId: "run-1",
    dueAt: "2026-04-20T12:00:00.000Z",
    status: "pending",
    reason: "continue monitoring",
    payload: null,
    createdAt: "2026-04-20T11:59:00.000Z",
    consumedAt: null,
    cancelledAt: null,
    cancelledReason: null,
    ...overrides,
  };
}

function claimed(runId = "run-1"): ClaimMissionWakeOutcome {
  return {
    kind: "claimed",
    route: "continuation",
    runId,
    lease: makeStubLease(runId),
  };
}

type ClaimMissionWake = (
  input: ClaimMissionWakeInput,
) => Promise<ClaimMissionWakeOutcome>;

function makeDeps(overrides: Partial<WakeDeps> = {}): WakeDeps {
  return {
    listDueMissionWakes: vi.fn().mockResolvedValue([]),
    claimMissionWake: vi.fn<ClaimMissionWake>().mockResolvedValue(claimed()),
    listDueSessionWakes: vi.fn().mockResolvedValue([]),
    claimSessionWake: vi.fn().mockResolvedValue({
      kind: "claimed",
      lease: makeStubLease(null),
    }),
    injectWakeBanner: vi.fn().mockResolvedValue(undefined),
    resumeMissionRun: vi.fn().mockResolvedValue(undefined),
    continueAgentSession: vi.fn().mockResolvedValue(undefined),
    isProviderReady: vi.fn(() => true),
    ...overrides,
  };
}

function outcomeAt(results: Awaited<ReturnType<typeof tick>>, index: number) {
  return requireValue(results[index]).outcome;
}

describe("wake.executor.tick", () => {
  beforeEach(() => {
    mockCreateLeaseHandle.mockReset();
    mockCreateLeaseHandle.mockReturnValue({
      lease: makeStubLease(),
      ownerId: "test-owner",
      release: vi.fn().mockResolvedValue(undefined),
    });
    mockReleaseLease.mockReset();
    mockReleaseLease.mockResolvedValue(undefined);
    mockScheduleAgentSessionContinuation.mockReset();
    mockScheduleAgentSessionContinuation.mockResolvedValue({
      scheduled: true,
      dueAt: "2026-04-20T12:00:05.000Z",
    });
    mockAppendEngineMessage.mockReset();
    mockAppendEngineMessage.mockResolvedValue(undefined);
  });

  // ── Session-scoped agent continuation (no mission run row) ───────
  describe("agent-session wakes", () => {
    const agentWake = () =>
      makeWake({
        id: "wake-agent-1",
        missionRunId: null,
        reason: "iteration_limit: runtime slice exhausted; continue autonomously",
        payload: { trigger: "iteration_limit", automatic: true },
      });

    it("is listed and claimed through the session claim, never the mission claim", async () => {
      const deps = makeDeps({
        listDueSessionWakes: vi.fn().mockResolvedValue([agentWake()]),
      });
      const now = new Date("2026-04-20T12:00:01.000Z");

      await tick(now, 10, deps);

      expect(deps.listDueMissionWakes).toHaveBeenCalledWith(now, 10);
      expect(deps.listDueSessionWakes).toHaveBeenCalledWith(now, 10);
      expect(deps.claimSessionWake).toHaveBeenCalledWith(
        expect.objectContaining({
          ownerId: "wake-executor-wake-agent-1",
          now,
        }),
      );
      expect(deps.claimMissionWake).not.toHaveBeenCalled();
    });

    it("continues the session under the atomic claim", async () => {
      const deps = makeDeps({
        listDueSessionWakes: vi.fn().mockResolvedValue([agentWake()]),
      });

      const results = await tick(new Date("2026-04-20T12:00:01.000Z"), 10, deps);

      expect(outcomeAt(results, 0)).toEqual({
        kind: "agent_session_continued",
        sessionId: "sess-1",
      });
      expect(deps.resumeMissionRun).not.toHaveBeenCalled();
      expect(deps.injectWakeBanner).toHaveBeenCalledWith(
        "sess-1",
        "iteration_limit: runtime slice exhausted; continue autonomously",
        "2026-04-20T12:00:00.000Z",
        undefined, // pin: every wake path forwards payload.triggeredBy; a timer wake has none
      );
      expect(deps.continueAgentSession).toHaveBeenCalledWith(
        "sess-1",
        "wake-executor-wake-agent-1",
      );
    });

    it("banner precedes the continuation, and the lease is always released", async () => {
      const continueAgentSession = vi.fn().mockResolvedValue(undefined);
      const injectWakeBanner = vi.fn().mockResolvedValue(undefined);
      const deps = makeDeps({
        listDueSessionWakes: vi.fn().mockResolvedValue([agentWake()]),
        continueAgentSession,
        injectWakeBanner,
      });

      await tick(new Date(), 10, deps);

      expect(injectWakeBanner).toHaveBeenCalledBefore(continueAgentSession);
      expect(mockReleaseLease).toHaveBeenCalledWith(
        expect.anything(),
        "sess-1",
      );
    });

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

      expect(outcomeAt(results, 0)).toEqual({
        kind: "deferred_lease_busy",
        sessionId: "sess-1",
        attempt: 1,
        dueAt: "2026-04-20T12:00:06.000Z",
      });
      expect(deps.injectWakeBanner).not.toHaveBeenCalled();
      expect(deps.continueAgentSession).not.toHaveBeenCalled();
      expect(mockScheduleAgentSessionContinuation).not.toHaveBeenCalled();
    });

    it("starts nothing when the row stopped being claimable under the lock", async () => {
      const deps = makeDeps({
        listDueSessionWakes: vi.fn().mockResolvedValue([agentWake()]),
        claimSessionWake: vi.fn().mockResolvedValue({ kind: "not_claimable" }),
      });

      const results = await tick(new Date(), 10, deps);

      expect(outcomeAt(results, 0)).toEqual({ kind: "skipped_claim_lost" });
      expect(deps.injectWakeBanner).not.toHaveBeenCalled();
      expect(deps.continueAgentSession).not.toHaveBeenCalled();
    });

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

      expect(outcomeAt(results, 0)).toEqual({
        kind: "error",
        message: "provider down",
      });
      expect(mockReleaseLease).toHaveBeenCalled();
    });
  });

  // ── Mission-scoped wakes ─────────────────────────────────────────
  describe("mission wakes", () => {
    it("resumes a mission run only after the atomic claim, with the claim's lease", async () => {
      const claimMissionWake = vi.fn<ClaimMissionWake>().mockResolvedValue(claimed());
      const injectWakeBanner = vi.fn().mockResolvedValue(undefined);
      const now = new Date("2026-04-20T12:00:01.000Z");
      const deps = makeDeps({
        listDueMissionWakes: vi.fn().mockResolvedValue([makeWake()]),
        claimMissionWake,
        injectWakeBanner,
      });

      const results = await tick(now, 10, deps);

      expect(results).toHaveLength(1);
      expect(outcomeAt(results, 0)).toEqual({ kind: "resumed", runId: "run-1" });
      expect(claimMissionWake).toHaveBeenCalledWith({
        wake: makeWake(),
        ownerId: "wake-executor-wake-1",
        ttlMs: 5 * 60_000,
        now,
      });
      expect(claimMissionWake).toHaveBeenCalledBefore(injectWakeBanner);
      expect(mockCreateLeaseHandle).toHaveBeenCalledWith(
        expect.objectContaining({
          lease: expect.objectContaining({ missionRunId: "run-1" }),
          ownerId: "wake-executor-wake-1",
        }),
      );
      expect(injectWakeBanner).toHaveBeenCalledWith(
        "sess-1",
        "continue monitoring",
        "2026-04-20T12:00:00.000Z",
        undefined,
      );
      expect(deps.resumeMissionRun).toHaveBeenCalledWith(
        "run-1",
        "wake-executor-wake-1",
      );
      expect(mockReleaseLease).toHaveBeenCalledWith(
        expect.anything(),
        "sess-1",
        { missionRunId: "run-1" },
      );
    });

    it("routes an error-retry wake with the auto-retry owner id", async () => {
      const claimMissionWake = vi.fn<ClaimMissionWake>().mockResolvedValue({
        kind: "claimed",
        route: "auto_retry",
        runId: "run-1",
        lease: makeStubLease(),
      });
      const deps = makeDeps({
        listDueMissionWakes: vi.fn().mockResolvedValue([
          makeWake({ id: "wake-9", payload: { trigger: "error_retry", attempt: 2 } }),
        ]),
        claimMissionWake,
      });

      const results = await tick(new Date(), 10, deps);

      expect(outcomeAt(results, 0)).toEqual({ kind: "resumed", runId: "run-1" });
      expect(claimMissionWake).toHaveBeenCalledWith(
        expect.objectContaining({ ownerId: "auto-retry-wake-9" }),
      );
      expect(deps.resumeMissionRun).toHaveBeenCalledWith("run-1", "auto-retry-wake-9");
    });

    it("an auto-retry the claim refused starts nothing", async () => {
      const deps = makeDeps({
        listDueMissionWakes: vi.fn().mockResolvedValue([
          makeWake({ payload: { trigger: "error_retry", attempt: 2 } }),
        ]),
        claimMissionWake: vi.fn<ClaimMissionWake>().mockResolvedValue({
          kind: "dropped",
          reason: "auto_retry_ineligible",
          currentStatus: "paused_error",
        }),
      });

      const results = await tick(new Date(), 10, deps);

      expect(outcomeAt(results, 0)).toEqual({ kind: "skipped_claim_lost" });
      expect(deps.injectWakeBanner).not.toHaveBeenCalled();
      expect(deps.resumeMissionRun).not.toHaveBeenCalled();
    });

    it("a run the wake can no longer resume is reported stale and starts nothing", async () => {
      const deps = makeDeps({
        listDueMissionWakes: vi.fn().mockResolvedValue([makeWake()]),
        claimMissionWake: vi.fn<ClaimMissionWake>().mockResolvedValue({
          kind: "dropped",
          reason: "not_resumable",
          currentStatus: "completed",
        }),
      });

      const results = await tick(new Date(), 10, deps);

      expect(outcomeAt(results, 0)).toEqual({
        kind: "skipped_stale_status",
        currentStatus: "completed",
      });
      expect(deps.injectWakeBanner).not.toHaveBeenCalled();
      expect(deps.resumeMissionRun).not.toHaveBeenCalled();
      expect(mockCreateLeaseHandle).not.toHaveBeenCalled();
    });

    it("a missing run is reported as such and starts nothing", async () => {
      const deps = makeDeps({
        listDueMissionWakes: vi.fn().mockResolvedValue([makeWake()]),
        claimMissionWake: vi.fn<ClaimMissionWake>().mockResolvedValue({
          kind: "dropped",
          reason: "run_missing",
          currentStatus: null,
        }),
      });

      const results = await tick(new Date(), 10, deps);

      expect(outcomeAt(results, 0)).toEqual({ kind: "skipped_mission_run_missing" });
      expect(deps.resumeMissionRun).not.toHaveBeenCalled();
    });

    /**
     * The old batch claim consumed the row first and then dropped it on a busy
     * lease or a run still unwinding toward its park - the run then sat in
     * `paused_wake` forever. Now the SAME row is kept pending and pushed out.
     */
    it.each(["lease_busy", "run_active"] as const)(
      "a %s claim defers the row and starts nothing",
      async (cause) => {
        const deps = makeDeps({
          listDueMissionWakes: vi.fn().mockResolvedValue([makeWake()]),
          claimMissionWake: vi.fn<ClaimMissionWake>().mockResolvedValue({
            kind: "deferred",
            cause,
            attempt: 1,
            dueAt: "2026-04-20T12:00:06.000Z",
          }),
        });

        const results = await tick(new Date(), 10, deps);

        expect(outcomeAt(results, 0)).toEqual({
          kind: "deferred_lease_busy",
          sessionId: "sess-1",
          attempt: 1,
          dueAt: "2026-04-20T12:00:06.000Z",
        });
        expect(deps.injectWakeBanner).not.toHaveBeenCalled();
        expect(deps.resumeMissionRun).not.toHaveBeenCalled();
      },
    );

    it("a row claimed or cancelled by someone else starts nothing", async () => {
      const deps = makeDeps({
        listDueMissionWakes: vi.fn().mockResolvedValue([makeWake()]),
        claimMissionWake: vi.fn<ClaimMissionWake>().mockResolvedValue({
          kind: "not_claimable",
        }),
      });

      const results = await tick(new Date(), 10, deps);

      expect(outcomeAt(results, 0)).toEqual({ kind: "skipped_claim_lost" });
      expect(deps.resumeMissionRun).not.toHaveBeenCalled();
    });

    /**
     * The crash-safety property at the tick level: the second candidate is not
     * claimed until the first one's run has finished. A process that dies
     * while the first run is in flight has consumed exactly one row.
     */
    it("claims ONE candidate at a time: the next claim waits for the previous run", async () => {
      let finishFirstRun: () => void = () => {};
      const firstRun = new Promise<void>((resolve) => {
        finishFirstRun = resolve;
      });
      const claimMissionWake = vi.fn<ClaimMissionWake>((input) =>
        Promise.resolve(claimed(input.wake.missionRunId ?? "none")));
      const resumeMissionRun = vi.fn((runId: string) =>
        runId === "run-a" ? firstRun : Promise.resolve());
      const deps = makeDeps({
        listDueMissionWakes: vi.fn().mockResolvedValue([
          makeWake({ id: "wake-a", missionRunId: "run-a" }),
          makeWake({ id: "wake-b", missionRunId: "run-b" }),
          makeWake({ id: "wake-c", missionRunId: "run-c" }),
        ]),
        claimMissionWake,
        resumeMissionRun,
      });

      const pass = tick(new Date(), 10, deps);
      await vi.waitFor(() => expect(resumeMissionRun).toHaveBeenCalledTimes(1));

      // Run A is in flight: B and C are still unclaimed (and therefore pending).
      expect(claimMissionWake).toHaveBeenCalledTimes(1);

      finishFirstRun();
      const results = await pass;

      expect(results.map((r) => r.outcome)).toEqual([
        { kind: "resumed", runId: "run-a" },
        { kind: "resumed", runId: "run-b" },
        { kind: "resumed", runId: "run-c" },
      ]);
      expect(claimMissionWake.mock.calls.map(([input]) => input.wake.id)).toEqual([
        "wake-a",
        "wake-b",
        "wake-c",
      ]);
    });

    it("reports an error outcome without poisoning the rest of the batch", async () => {
      const deps = makeDeps({
        listDueMissionWakes: vi.fn().mockResolvedValue([
          makeWake({ id: "wake-a", missionRunId: "run-a" }),
          makeWake({ id: "wake-b", missionRunId: "run-b" }),
        ]),
        claimMissionWake: vi.fn<ClaimMissionWake>((input) =>
          input.wake.id === "wake-a"
            ? Promise.reject(new Error("db exploded"))
            : Promise.resolve(claimed("run-b"))),
      });

      const results = await tick(new Date(), 10, deps);

      expect(results).toHaveLength(2);
      expect(outcomeAt(results, 0)).toEqual({ kind: "error", message: "db exploded" });
      expect(outcomeAt(results, 1)).toEqual({ kind: "resumed", runId: "run-b" });
    });
  });

  it("returns an empty array when nothing is due", async () => {
    const deps = makeDeps();
    const results = await tick(new Date(), 10, deps);
    expect(results).toEqual([]);
    expect(deps.injectWakeBanner).not.toHaveBeenCalled();
  });

  it("does NOT list or claim when provider config is absent (pre-claim gate)", async () => {
    const listDueMissionWakes = vi.fn().mockResolvedValue([makeWake()]);
    const deps = makeDeps({ listDueMissionWakes, isProviderReady: () => false });

    const results = await tick(new Date(), 10, deps);

    expect(results).toEqual([]);
    expect(listDueMissionWakes).not.toHaveBeenCalled();
    expect(deps.claimMissionWake).not.toHaveBeenCalled();
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
