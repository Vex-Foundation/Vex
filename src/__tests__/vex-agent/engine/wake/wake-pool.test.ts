/**
 * Kairos S-3: the concurrent wake pool and its switch.
 *
 * Proven here with fakes (the DB-backed proof is
 * `integration/engine/wake-concurrency.int.test.ts`):
 *   - the default (`AGENT_WAKE_CONCURRENCY` unset = 1) executor produces the
 *     exact claim / run order of the serial `tick`, never builds the pool and
 *     never looks a wallet up;
 *   - above 1, a pass starts every admissible candidate without awaiting any
 *     slice, bounded by the concurrency;
 *   - two slices of one session never run together, nor two slices whose
 *     sessions select one wallet; a skipped candidate is never claimed;
 *   - a failed wallet lookup fails closed; a failed slice frees its slot;
 *   - stop() drains the slices in flight and starts no new one.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockReleaseLease = vi.fn().mockResolvedValue(undefined);
const mockCreateLeaseHandle = vi.fn();

vi.mock("@vex-agent/engine/runtime/lease-handle.js", () => ({
  createLeaseHandle: (...a: unknown[]) => mockCreateLeaseHandle(...a),
}));

vi.mock("@vex-agent/engine/runtime/release-and-emit.js", () => ({
  releaseLeaseAndEmitControlState: (...a: unknown[]) => mockReleaseLease(...a),
}));

vi.mock("@vex-agent/engine/runtime/error-bus.js", () => ({
  emitEngineError: vi.fn(),
  errorDetailOf: () => "detail",
}));

vi.mock("@vex-agent/engine/support/bug-report-registry.js", () => ({
  getBugReportSink: () => null,
}));

import {
  startWakeExecutor,
  tick,
  type StartOptions,
  type WakeDeps,
} from "../../../../vex-agent/engine/wake/executor.js";
import { createWakePool } from "../../../../vex-agent/engine/wake/executor/pool.js";
import { walletKeysOf } from "../../../../vex-agent/engine/wake/executor/wallet-keys.js";
import type { ClaimedWake } from "../../../../vex-agent/engine/wake/executor/tick.js";
import type {
  ClaimMissionWakeInput,
  ClaimMissionWakeOutcome,
} from "../../../../vex-agent/engine/wake/executor/claim-mission-wake.js";
import type {
  ClaimSessionWakeInput,
  ClaimSessionWakeOutcome,
} from "../../../../vex-agent/engine/wake/executor/claim-session-wake.js";
import type { LoopWakeRequest } from "../../../../vex-agent/db/repos/loop-wake.js";
import type { RunnerLease } from "../../../../vex-agent/db/repos/runner-leases.js";
import type { RunnerLeaseGuard } from "../../../../vex-agent/engine/runtime/lease-guard.js";
import { fakeLeaseHandle } from "../../../helpers/lease-guard.js";

// ── Fixtures ──────────────────────────────────────────────────────

function lease(sessionId: string, missionRunId: string | null): RunnerLease {
  return {
    sessionId,
    missionRunId,
    ownerId: "test-owner",
    processKind: "electron_main",
    acquiredAt: new Date(),
    heartbeatAt: new Date(),
    expiresAt: new Date(),
    claimToken: `token-${sessionId}`,
  };
}

/** A session-scoped wake (Full-Autonomous continuation) for `sessionId`. */
function sessionWake(id: string, sessionId: string): LoopWakeRequest {
  return {
    id,
    sessionId,
    missionRunId: null,
    dueAt: "2026-09-30T12:00:00.000Z",
    status: "pending",
    reason: "continue",
    payload: null,
    createdAt: "2026-09-30T11:59:00.000Z",
    consumedAt: null,
    cancelledAt: null,
    cancelledReason: null,
  };
}

/** A mission-scoped wake for run `runId` of `sessionId`. */
function missionWake(id: string, sessionId: string, runId: string): LoopWakeRequest {
  return { ...sessionWake(id, sessionId), missionRunId: runId };
}

interface Gate {
  readonly promise: Promise<void>;
  open(): void;
}

function gate(): Gate {
  let open: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

/**
 * Deps that record every claim and slice boundary into `events`. `gates`
 * holds a slice open by session id until the test opens it.
 */
function recordingDeps(input: {
  readonly events: string[];
  readonly missionRows?: () => LoopWakeRequest[];
  readonly sessionRows?: () => LoopWakeRequest[];
  readonly gates?: ReadonlyMap<string, Gate>;
  readonly failSession?: string;
}): WakeDeps {
  const { events } = input;
  const slice = async (sessionId: string): Promise<void> => {
    events.push(`run:${sessionId}:start`);
    const held = input.gates?.get(sessionId);
    if (held !== undefined) await held.promise;
    if (input.failSession === sessionId) {
      events.push(`run:${sessionId}:fail`);
      throw new Error("slice failed");
    }
    events.push(`run:${sessionId}:end`);
  };
  return {
    listDueMissionWakes: vi.fn((_now: Date, _limit: number) => {
      events.push("list:mission");
      return Promise.resolve(input.missionRows?.() ?? []);
    }),
    claimMissionWake: vi.fn((claim: ClaimMissionWakeInput): Promise<ClaimMissionWakeOutcome> => {
      events.push(`claim:${claim.wake.id}`);
      const runId = claim.wake.missionRunId ?? "none";
      return Promise.resolve({
        kind: "claimed",
        route: "continuation",
        runId,
        lease: lease(claim.wake.sessionId, runId),
      });
    }),
    listDueSessionWakes: vi.fn((_now: Date, _limit: number) => {
      events.push("list:session");
      return Promise.resolve(input.sessionRows?.() ?? []);
    }),
    claimSessionWake: vi.fn((claim: ClaimSessionWakeInput): Promise<ClaimSessionWakeOutcome> => {
      events.push(`claim:${claim.wake.id}`);
      return Promise.resolve({ kind: "claimed", lease: lease(claim.wake.sessionId, null) });
    }),
    injectWakeBanner: vi.fn().mockResolvedValue(undefined),
    resumeMissionRun: vi.fn(async (runId: string, _lease: RunnerLeaseGuard) => {
      await slice(runId.replace(/^run-/, ""));
    }),
    continueAgentSession: vi.fn(async (sessionId: string, _lease: RunnerLeaseGuard) => {
      await slice(sessionId);
    }),
    isProviderReady: vi.fn(() => true),
  };
}

/** Fire the list once, then nothing: the rows are consumed by their claims. */
function once(rows: LoopWakeRequest[]): () => LoopWakeRequest[] {
  let served = false;
  return () => {
    if (served) return [];
    served = true;
    return rows;
  };
}

function quietSubsidiaries(): Pick<
  StartOptions,
  "startWatchPromoter" | "startPriceWatchPoller" | "startRestartOrphanReclaim" | "startStuckWakeRepair"
> {
  return {
    startWatchPromoter: () => ({ stop: vi.fn() }),
    startPriceWatchPoller: () => ({ stop: vi.fn().mockResolvedValue(undefined) }),
    startRestartOrphanReclaim: () => ({ stop: vi.fn().mockResolvedValue(undefined) }),
    startStuckWakeRepair: () => ({ stop: vi.fn().mockResolvedValue(undefined) }),
  };
}

const noWallets = vi.fn((_sessionId: string) => Promise.resolve<readonly string[]>([]));

beforeEach(() => {
  mockCreateLeaseHandle.mockReset();
  mockCreateLeaseHandle.mockImplementation((opts: { readonly ownerId: string }) =>
    fakeLeaseHandle({ ownerId: opts.ownerId }));
  mockReleaseLease.mockReset();
  mockReleaseLease.mockResolvedValue(undefined);
  noWallets.mockClear();
});

// ── The switch: default == the serial executor ───────────────────

describe("startWakeExecutor default concurrency (switch OFF)", () => {
  const saved = process.env.AGENT_WAKE_CONCURRENCY;

  beforeEach(() => {
    delete process.env.AGENT_WAKE_CONCURRENCY;
  });

  afterEach(() => {
    vi.useRealTimers();
    if (saved === undefined) delete process.env.AGENT_WAKE_CONCURRENCY;
    else process.env.AGENT_WAKE_CONCURRENCY = saved;
  });

  const rows = (): LoopWakeRequest[] => [
    missionWake("wake-a", "a", "run-a"),
    missionWake("wake-b", "b", "run-b"),
  ];
  const sessionRows = (): LoopWakeRequest[] => [sessionWake("wake-c", "c")];

  it("claims and runs in exactly the serial tick's order, one slice at a time", async () => {
    // Reference: the serial pass itself.
    const reference: string[] = [];
    const referenceGate = gate();
    const referencePass = tick(
      new Date(),
      10,
      recordingDeps({
        events: reference,
        missionRows: rows,
        sessionRows,
        gates: new Map([["a", referenceGate]]),
      }),
    );
    await vi.waitFor(() => expect(reference).toContain("run:a:start"));
    referenceGate.open();
    await referencePass;

    vi.useFakeTimers();
    const events: string[] = [];
    const slowA = gate();
    const handle = startWakeExecutor({
      ...quietSubsidiaries(),
      intervalMs: 2000,
      batchSize: 10,
      deps: recordingDeps({
        events,
        missionRows: once(rows()),
        sessionRows: once(sessionRows()),
        gates: new Map([["a", slowA]]),
      }),
      walletKeysFor: noWallets,
    });

    await vi.advanceTimersByTimeAsync(2000);
    expect(events).toContain("run:a:start");
    // A holds the pass: nothing else is claimed, no second pass is listed.
    await vi.advanceTimersByTimeAsync(20_000);
    expect(events.filter((e) => e.startsWith("claim:"))).toEqual(["claim:wake-a"]);
    expect(events.filter((e) => e.startsWith("list:"))).toEqual(["list:mission", "list:session"]);

    slowA.open();
    await vi.advanceTimersByTimeAsync(0);
    await handle.stop();

    expect(events).toEqual(reference);
    // The pool was never built: no wallet lookup at concurrency 1.
    expect(noWallets).not.toHaveBeenCalled();
  });

  it("an explicit concurrency of 1 is the same serial executor", async () => {
    vi.useFakeTimers();
    const events: string[] = [];
    const slowA = gate();
    const handle = startWakeExecutor({
      ...quietSubsidiaries(),
      intervalMs: 2000,
      concurrency: 1,
      deps: recordingDeps({
        events,
        missionRows: once(rows()),
        sessionRows: once(sessionRows()),
        gates: new Map([["a", slowA]]),
      }),
      walletKeysFor: noWallets,
    });
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(events.filter((e) => e.startsWith("claim:"))).toEqual(["claim:wake-a"]);
    slowA.open();
    await vi.advanceTimersByTimeAsync(0);
    await handle.stop();
    expect(events.filter((e) => e.startsWith("claim:"))).toEqual([
      "claim:wake-a",
      "claim:wake-b",
      "claim:wake-c",
    ]);
    expect(noWallets).not.toHaveBeenCalled();
  });

  it("reads AGENT_WAKE_CONCURRENCY when no option is given", async () => {
    process.env.AGENT_WAKE_CONCURRENCY = "3";
    const events: string[] = [];
    const slowA = gate();
    const handle = startWakeExecutor({
      ...quietSubsidiaries(),
      intervalMs: 10,
      deps: recordingDeps({
        events,
        missionRows: once(rows()),
        sessionRows: once(sessionRows()),
        gates: new Map([["a", slowA]]),
      }),
      walletKeysFor: noWallets,
    });
    // Concurrent: B and C were claimed and finished while A is still running.
    await vi.waitFor(() => {
      expect(events).toContain("run:b:end");
      expect(events).toContain("run:c:end");
    });
    expect(events).not.toContain("run:a:end");
    slowA.open();
    await handle.stop();
    expect(events).toContain("run:a:end");
  });

  it("refuses a concurrency below 1 before starting anything", () => {
    const startWatchPromoter = vi.fn(() => ({ stop: vi.fn() }));
    expect(() =>
      startWakeExecutor({
        ...quietSubsidiaries(),
        startWatchPromoter,
        concurrency: 0,
        deps: recordingDeps({ events: [] }),
      }),
    ).toThrow("concurrency");
    expect(startWatchPromoter).not.toHaveBeenCalled();
  });
});

// ── The pool ──────────────────────────────────────────────────────

describe("createWakePool", () => {
  it("starts every admissible candidate in one pass without awaiting any slice", async () => {
    const events: string[] = [];
    const slowA = gate();
    const settled: ClaimedWake[] = [];
    const pool = createWakePool({
      concurrency: 3,
      limit: 10,
      deps: recordingDeps({
        events,
        missionRows: once([missionWake("wake-a", "a", "run-a")]),
        sessionRows: once([sessionWake("wake-b", "b"), sessionWake("wake-c", "c")]),
        gates: new Map([["a", slowA]]),
      }),
      walletKeysFor: noWallets,
      onSettled: (r) => settled.push(r),
    });

    const result = await pool.pass(new Date());
    expect(result.started.map((w) => w.id)).toEqual(["wake-a", "wake-b", "wake-c"]);
    expect(result.skipped).toEqual([]);

    await vi.waitFor(() => expect(settled).toHaveLength(2));
    expect(settled.map((r) => r.outcome)).toEqual([
      { kind: "agent_session_continued", sessionId: "b" },
      { kind: "agent_session_continued", sessionId: "c" },
    ]);
    expect(pool.inFlightCount()).toBe(1);

    slowA.open();
    await pool.drain();
    expect(settled.map((r) => r.outcome.kind)).toContain("resumed");
    expect(pool.inFlightCount()).toBe(0);
    // Each lease released exactly once.
    expect(mockReleaseLease).toHaveBeenCalledTimes(3);
  });

  it("never exceeds the concurrency; the rest stay unclaimed for a later pass", async () => {
    const events: string[] = [];
    const gates = new Map([["a", gate()], ["b", gate()]]);
    const pending = [
      sessionWake("wake-a", "a"),
      sessionWake("wake-b", "b"),
      sessionWake("wake-c", "c"),
      sessionWake("wake-d", "d"),
    ];
    const deps = recordingDeps({
      events,
      sessionRows: () => pending.filter((w) => !events.includes(`claim:${w.id}`)),
      gates,
    });
    const pool = createWakePool({ concurrency: 2, limit: 10, deps, walletKeysFor: noWallets });

    const first = await pool.pass(new Date());
    expect(first.started.map((w) => w.id)).toEqual(["wake-a", "wake-b"]);
    expect(deps.claimSessionWake).toHaveBeenCalledTimes(2);

    // A full pool does not even list.
    const full = await pool.pass(new Date());
    expect(full.started).toEqual([]);
    expect(deps.listDueSessionWakes).toHaveBeenCalledTimes(1);

    gates.get("a")?.open();
    await vi.waitFor(() => expect(pool.inFlightCount()).toBe(1));
    const second = await pool.pass(new Date());
    expect(second.started.map((w) => w.id)).toEqual(["wake-c"]);

    gates.get("b")?.open();
    await pool.drain();
    const third = await pool.pass(new Date());
    expect(third.started.map((w) => w.id)).toEqual(["wake-d"]);
    await pool.drain();
    expect(events.filter((e) => e.startsWith("claim:"))).toEqual([
      "claim:wake-a",
      "claim:wake-b",
      "claim:wake-c",
      "claim:wake-d",
    ]);
  });

  it("never runs two slices of one session: a second row of a busy session is not even claimed", async () => {
    const events: string[] = [];
    const slowA = gate();
    let listed = 0;
    const deps = recordingDeps({
      events,
      missionRows: () => {
        listed += 1;
        return listed === 1 ? [missionWake("wake-a1", "a", "run-a")] : [];
      },
      // A second row of session `a` appears while its slice runs, and the
      // first row is still listed by a pass that raced its own claim.
      sessionRows: () => (listed === 1 ? [] : [sessionWake("wake-a1", "a"), sessionWake("wake-a2", "a")]),
      gates: new Map([["a", slowA]]),
    });
    const pool = createWakePool({ concurrency: 3, limit: 10, deps, walletKeysFor: noWallets });

    await pool.pass(new Date());
    await vi.waitFor(() => expect(events).toContain("run:a:start"));
    const second = await pool.pass(new Date());
    expect(second.started).toEqual([]);
    expect(second.skipped.map((s) => [s.wake.id, s.reason])).toEqual([
      ["wake-a1", "session_in_flight"],
      ["wake-a2", "session_in_flight"],
    ]);
    expect(deps.claimSessionWake).not.toHaveBeenCalled();
    expect(events.filter((e) => e === "run:a:start")).toHaveLength(1);

    slowA.open();
    await pool.drain();
    const third = await pool.pass(new Date());
    // Admitted again once the slice ended; the pool claims one row of the
    // session per pass (here the claim itself decides what the row is worth).
    expect(third.started.map((w) => w.id)).toEqual(["wake-a1"]);
    await pool.drain();
  });

  it("serializes slices whose sessions select one wallet, and runs different wallets together", async () => {
    const events: string[] = [];
    const slowA = gate();
    const wallets: Record<string, readonly string[]> = {
      a: walletKeysOf({ evmAddress: "0xAbCd000000000000000000000000000000000001", solanaAddress: null }),
      // Same EVM address, other case: the same wallet.
      b: walletKeysOf({ evmAddress: "0xabcd000000000000000000000000000000000001", solanaAddress: null }),
      c: walletKeysOf({ evmAddress: "0xabcd000000000000000000000000000000000002", solanaAddress: null }),
    };
    const pending = [sessionWake("wake-a", "a"), sessionWake("wake-b", "b"), sessionWake("wake-c", "c")];
    const deps = recordingDeps({
      events,
      sessionRows: () => pending.filter((w) => !events.includes(`claim:${w.id}`)),
      gates: new Map([["a", slowA]]),
    });
    const pool = createWakePool({
      concurrency: 3,
      limit: 10,
      deps,
      walletKeysFor: (sessionId) => Promise.resolve(wallets[sessionId] ?? []),
    });

    const first = await pool.pass(new Date());
    expect(first.started.map((w) => w.id)).toEqual(["wake-a", "wake-c"]);
    expect(first.skipped.map((s) => [s.wake.id, s.reason])).toEqual([["wake-b", "wallet_in_flight"]]);
    expect(events).not.toContain("claim:wake-b");

    // Still held while A runs.
    await vi.waitFor(() => expect(events).toContain("run:c:end"));
    const second = await pool.pass(new Date());
    expect(second.skipped.map((s) => [s.wake.id, s.reason])).toEqual([["wake-b", "wallet_in_flight"]]);

    slowA.open();
    await pool.drain();
    const third = await pool.pass(new Date());
    expect(third.started.map((w) => w.id)).toEqual(["wake-b"]);
    await pool.drain();

    const order = events.filter((e) => e.startsWith("run:a") || e.startsWith("run:b"));
    expect(order).toEqual(["run:a:start", "run:a:end", "run:b:start", "run:b:end"]);
  });

  it("a shared Solana wallet serializes too", async () => {
    const slowA = gate();
    const events: string[] = [];
    const deps = recordingDeps({
      events,
      sessionRows: once([sessionWake("wake-a", "a"), sessionWake("wake-b", "b")]),
      gates: new Map([["a", slowA]]),
    });
    const sol = "So11111111111111111111111111111111111111112";
    const pool = createWakePool({
      concurrency: 2,
      limit: 10,
      deps,
      walletKeysFor: (sessionId) =>
        Promise.resolve(walletKeysOf({
          evmAddress: sessionId === "a" ? "0x0000000000000000000000000000000000000001" : null,
          solanaAddress: sol,
        })),
    });
    const first = await pool.pass(new Date());
    expect(first.started.map((w) => w.id)).toEqual(["wake-a"]);
    expect(first.skipped.map((s) => s.reason)).toEqual(["wallet_in_flight"]);
    slowA.open();
    await pool.drain();
  });

  it("fails closed when the wallet lookup fails: the candidate is not claimed", async () => {
    const events: string[] = [];
    const deps = recordingDeps({ events, sessionRows: once([sessionWake("wake-a", "a")]) });
    const pool = createWakePool({
      concurrency: 2,
      limit: 10,
      deps,
      walletKeysFor: () => Promise.reject(new Error("db down")),
    });
    const result = await pool.pass(new Date());
    expect(result.started).toEqual([]);
    expect(result.skipped.map((s) => s.reason)).toEqual(["wallet_lookup_failed"]);
    expect(deps.claimSessionWake).not.toHaveBeenCalled();
  });

  it("does not list or claim when the provider is not configured", async () => {
    const deps = recordingDeps({ events: [], sessionRows: () => [sessionWake("wake-a", "a")] });
    deps.isProviderReady = () => false;
    const pool = createWakePool({ concurrency: 2, limit: 10, deps, walletKeysFor: noWallets });
    expect(await pool.pass(new Date())).toEqual({ started: [], skipped: [] });
    expect(deps.listDueSessionWakes).not.toHaveBeenCalled();
  });

  it("a failed slice is reported as an error outcome and frees its slot", async () => {
    const settled: ClaimedWake[] = [];
    const deps = recordingDeps({
      events: [],
      sessionRows: once([sessionWake("wake-a", "a"), sessionWake("wake-b", "b")]),
      failSession: "a",
    });
    const pool = createWakePool({
      concurrency: 2,
      limit: 10,
      deps,
      walletKeysFor: noWallets,
      onSettled: (r) => settled.push(r),
    });
    await pool.pass(new Date());
    await pool.drain();
    expect(settled.map((r) => [r.wake.id, r.outcome.kind]).sort()).toEqual([
      ["wake-a", "error"],
      ["wake-b", "agent_session_continued"],
    ]);
    expect(pool.inFlightCount()).toBe(0);
    // The lease of the failed slice is still released.
    expect(mockReleaseLease).toHaveBeenCalledTimes(2);
  });

  it("rejects a non-positive concurrency", () => {
    expect(() =>
      createWakePool({ concurrency: 0, limit: 10, deps: recordingDeps({ events: [] }), walletKeysFor: noWallets }),
    ).toThrow("concurrency");
  });
});

// ── Shutdown ──────────────────────────────────────────────────────

describe("startWakeExecutor stop() with the pool", () => {
  it("drains the slices in flight and starts no new one", async () => {
    const events: string[] = [];
    const slowA = gate();
    let lists = 0;
    const handle = startWakeExecutor({
      ...quietSubsidiaries(),
      intervalMs: 10,
      concurrency: 3,
      deps: recordingDeps({
        events,
        sessionRows: () => {
          lists += 1;
          return lists === 1 ? [sessionWake("wake-a", "a")] : [];
        },
        gates: new Map([["a", slowA]]),
      }),
      walletKeysFor: noWallets,
    });
    await vi.waitFor(() => expect(events).toContain("run:a:start"));

    let stopped = false;
    const stopping = handle.stop().then(() => {
      stopped = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    // Still draining: the slice has not ended.
    expect(stopped).toBe(false);
    const listsAtStop = lists;

    slowA.open();
    await stopping;
    expect(events).toContain("run:a:end");
    expect(mockReleaseLease).toHaveBeenCalledTimes(1);

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(lists).toBe(listsAtStop);
  });
});

describe("walletKeysOf", () => {
  it("lowercases EVM, keeps Solana's case, and skips an empty selection", () => {
    expect(walletKeysOf({ evmAddress: "0xAB", solanaAddress: "AbC" })).toEqual(["evm:0xab", "solana:AbC"]);
    expect(walletKeysOf({ evmAddress: null, solanaAddress: null })).toEqual([]);
    expect(walletKeysOf({ evmAddress: " ", solanaAddress: null })).toEqual([]);
  });
});
