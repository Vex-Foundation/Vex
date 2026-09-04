/**
 * The Vex Studio READINESS BARRIER, owned by the settlement bridge.
 *
 * Three properties, each of which was a live defect:
 *
 *   1. THE PREFLIGHT IS REGISTERED BEFORE THE RECONCILER RUNS, and it refuses
 *      while the runtime is not ready. The engine's default with nothing
 *      registered is ALLOW; a dispatch admitted during the abandoned-dispatch
 *      scan would have its own fresh `dispatching` row declared indeterminate
 *      by that very scan.
 *   2. A REGISTRATION FAILURE FAILS CLOSED. Studio stays unready, by name.
 *   3. TEARDOWN DENIES. Removing the predicate would restore default-ALLOW on
 *      a process that is shutting down.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../logger/index.js", () => ({
  log: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../../studio/approval-refusals.js", () => ({
  repairPendingStudioRefusal: vi.fn().mockResolvedValue(true),
}));
/**
 * The project-cleanup repair, mocked because it is the WORK a teardown must
 * not be able to start. It is launched after the barrier opens and never
 * awaited into readiness, so counting its calls is the only way to see it.
 */
const repairUnfinishedProjectCleanups = vi.fn((_deps: unknown) =>
  Promise.resolve(),
);
vi.mock("../../studio/project-delete.js", () => ({
  repairUnfinishedProjectCleanups: (deps: unknown) =>
    repairUnfinishedProjectCleanups(deps),
}));
/**
 * THE DATABASE, as the bridge actually sees it: the real
 * `database/engine-db-readiness.ts` owner over a faked compose boundary. Only
 * the two facts it reads are mocked - the connection config compose writes, and
 * the migration latch the migrate runner sets - so the wait, its single-flight
 * poll and its abort are the production ones.
 */
let poolConfig: {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly user: string;
  readonly password: string;
} | null = null;
let migrationsDone = false;
vi.mock("../../database/db-config.js", () => ({
  buildPoolConfig: () => Promise.resolve(poolConfig),
}));
vi.mock("../../database/migrations-applied.js", () => ({
  migrationsApplied: () => migrationsDone,
  markMigrationsApplied: () => {
    migrationsDone = true;
  },
}));
vi.mock("@vex-agent/db/client.js", () => ({ closePool: () => Promise.resolve() }));

/** Compose has finished: the password file is readable and the port is known. */
function databaseIsUp(): void {
  poolConfig = {
    host: "127.0.0.1",
    port: 5433,
    database: "vex",
    user: "vex",
    password: "test-password",
  };
  migrationsDone = true;
}

let secretSessionUnlocked = true;
let studioTransitioning = false;
let studioPoisoned = false;
vi.mock("../../secrets/session.js", () => ({
  isSecretSessionUnlocked: () => secretSessionUnlocked,
  isStudioSessionTransitionInProgress: () => studioTransitioning,
  isStudioDispatchPoisoned: () => studioPoisoned,
}));

const setStudioDispatchPreflight = vi.fn();
const reconcileAbandonedStudioDispatches = vi.fn();
const announceStudioReconciliations = vi.fn();
const reconcileUnstartedStudioApprovals = vi.fn();
const announceStudioUnstartedRefusals = vi.fn();
const disposeStudioWriteRepair = vi.fn();
/** Ordered trace: the registration must precede the scan, never follow it. */
const trace: string[] = [];

vi.mock("@vex-agent/engine/core/approval-runtime.js", () => ({
  setStudioDispatchPreflight: (fn: (() => boolean) | null) => {
    trace.push("preflight");
    setStudioDispatchPreflight(fn);
  },
  reconcileAbandonedStudioDispatches: async () => {
    trace.push("reconcile");
    return reconcileAbandonedStudioDispatches();
  },
  announceStudioReconciliations: (rows: unknown) => {
    announceStudioReconciliations(rows);
  },
  reconcileUnstartedStudioApprovals: async () => {
    trace.push("reconcile_unstarted");
    return reconcileUnstartedStudioApprovals();
  },
  announceStudioUnstartedRefusals: (rows: unknown) => {
    announceStudioUnstartedRefusals(rows);
  },
  disposeStudioWriteRepair: () => {
    disposeStudioWriteRepair();
  },
}));

const { setupStudioSettlementBridge, awaitStudioRuntimeReady } = await import(
  "../studio-settlement-bridge.js"
);
const { repairPendingStudioRefusal } = await import(
  "../../studio/approval-refusals.js"
);
const {
  isStudioRuntimeReady,
  studioReadiness,
  resetStudioReadinessForTests,
  requestStudioRuntimeRetry,
} = await import("../../studio/readiness.js");
const { resetEngineDbReadinessForTests } = await import(
  "../../database/engine-db-readiness.js"
);
/**
 * The REAL registry, deliberately unmocked: it is an import-free module, so
 * reading it here costs nothing and proves what the engine would actually see.
 */
const { readStudioDispatchPreflight, setStudioDispatchPreflight: setRealPreflight } =
  await import(
    "@vex-agent/engine/core/approval-runtime/studio/dispatch-preflight.js"
  );

beforeEach(() => {
  vi.clearAllMocks();
  trace.length = 0;
  secretSessionUnlocked = true;
  studioTransitioning = false;
  studioPoisoned = false;
  resetStudioReadinessForTests();
  resetEngineDbReadinessForTests();
  // Every pre-existing case describes a warm start: the database is already up
  // when the bridge starts. The cold start has its own describe below.
  databaseIsUp();
  delete process.env.VEX_DB_URL;
  reconcileAbandonedStudioDispatches.mockResolvedValue([]);
  reconcileUnstartedStudioApprovals.mockResolvedValue([]);
  vi.mocked(repairPendingStudioRefusal).mockResolvedValue(true);
});

afterEach(() => {
  resetStudioReadinessForTests();
  resetEngineDbReadinessForTests();
  delete process.env.VEX_DB_URL;
  // The registry is process-wide: one case's predicate must not decide the
  // next case's dispatch.
  setRealPreflight(null);
});

describe("the readiness barrier", () => {
  it("registers the preflight, reconciles, and only then opens Studio", async () => {
    expect(isStudioRuntimeReady()).toBe(false);
    // Hold the scan open so the window it creates can be observed directly.
    let releaseScan = (): void => {};
    const scanning = new Promise<void>((resolve) => {
      releaseScan = () => {
        resolve();
      };
    });
    reconcileAbandonedStudioDispatches.mockImplementation(async () => {
      await scanning;
      return [];
    });

    const teardown = setupStudioSettlementBridge();
    await vi.waitFor(() => {
      expect(trace).toEqual(["preflight", "reconcile"]);
    });
    // The predicate exists BEFORE the scan finishes, and it says NO while the
    // scan runs: a dispatch admitted here would have its own fresh
    // `dispatching` row swept by that very scan.
    const registered = setStudioDispatchPreflight.mock.calls[0]?.[0] as
      | (() => boolean)
      | undefined;
    expect(typeof registered).toBe("function");
    expect(registered?.()).toBe(false);
    expect(isStudioRuntimeReady()).toBe(false);

    releaseScan();
    await awaitStudioRuntimeReady();
    expect(trace).toEqual(["preflight", "reconcile", "reconcile_unstarted"]);
    expect(isStudioRuntimeReady()).toBe(true);
    // The same predicate now allows: it reads the flag, it does not cache it.
    expect(registered?.()).toBe(true);

    // A non-signing Studio mutation uses the same preflight. Lock transition
    // denial cannot depend on the signer being scrubbed.
    studioTransitioning = true;
    expect(registered?.()).toBe(false);
    studioTransitioning = false;
    secretSessionUnlocked = false;
    expect(registered?.()).toBe(false);
    secretSessionUnlocked = true;
    studioPoisoned = true;
    expect(registered?.()).toBe(false);
    teardown();
  });

  it("stays UNREADY when the preflight cannot be registered", async () => {
    setStudioDispatchPreflight.mockImplementationOnce(() => {
      throw new Error("engine import failed");
    });
    const teardown = setupStudioSettlementBridge();
    await awaitStudioRuntimeReady();
    expect(isStudioRuntimeReady()).toBe(false);
    const readiness = studioReadiness();
    expect(readiness.ready).toBe(false);
    if (readiness.ready) return;
    expect(readiness.cause).toMatch(/approval fence/i);
    // And the reconciler never ran: nothing may write on an unproven fence.
    expect(trace).toEqual(["preflight"]);
    teardown();
  });

  it("stays UNREADY when a durable lock refusal is still unrepaired", async () => {
    vi.mocked(repairPendingStudioRefusal).mockResolvedValueOnce(false);
    const teardown = setupStudioSettlementBridge();
    await awaitStudioRuntimeReady();

    expect(isStudioRuntimeReady()).toBe(false);
    expect(reconcileAbandonedStudioDispatches).not.toHaveBeenCalled();
    const registered = setStudioDispatchPreflight.mock.calls[0]?.[0];
    expect(typeof registered).toBe("function");
    if (typeof registered !== "function") {
      throw new Error("dispatch preflight was not registered");
    }
    expect(registered()).toBe(false);
    teardown();
  });

  /**
   * TEARDOWN NEVER PUBLISHES READINESS.
   *
   * The reconciliation is awaited, so a teardown can land inside it. The write
   * itself was already epoch-fenced, but everything the caller did AFTERWARDS
   * was not: it logged a ready Studio the user reads as an open one, and it
   * launched the project-cleanup repair - fresh database work - on a process
   * that had just decided to go away. The transition now reports whether it
   * committed, and both of those live strictly after that answer.
   */
  it("publishes NOTHING when a teardown lands during the reconciliation", async () => {
    let releaseScan = (): void => {};
    const scanning = new Promise<void>((resolve) => {
      releaseScan = () => {
        resolve();
      };
    });
    reconcileAbandonedStudioDispatches.mockImplementation(async () => {
      await scanning;
      return [];
    });

    const teardown = setupStudioSettlementBridge();
    await vi.waitFor(() => {
      expect(trace).toEqual(["preflight", "reconcile"]);
    });

    teardown();
    releaseScan();
    // Well past every microtask the continuation could still be sitting on.
    await vi.waitFor(() => {
      expect(disposeStudioWriteRepair).toHaveBeenCalled();
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(isStudioRuntimeReady()).toBe(false);
    const readiness = studioReadiness();
    expect(readiness.ready).toBe(false);
    if (readiness.ready) return;
    expect(readiness.code).toBe("shutting_down");
    // No ready log for a Studio that is not open ...
    const { log } = await import("../../logger/index.js");
    const readyLines = vi
      .mocked(log.info)
      .mock.calls.filter((call) => String(call[0]).includes("studio runtime ready"));
    expect(readyLines).toEqual([]);
    // ... and no new work started behind it.
    expect(repairUnfinishedProjectCleanups).not.toHaveBeenCalled();
  });

  it("DENIES after teardown instead of restoring the engine default", async () => {
    const teardown = setupStudioSettlementBridge();
    await awaitStudioRuntimeReady();
    expect(isStudioRuntimeReady()).toBe(true);

    teardown();
    // Read from the REAL registry, and read it SYNCHRONOUSLY: the teardown deny
    // is a plain static call now, so there is no window between the teardown
    // returning and the engine seeing DENY. Waiting for it would hide exactly
    // the regression this pins.
    const last = readStudioDispatchPreflight();
    // NOT `null`: `null` is the engine's default-ALLOW, which belongs to a
    // headless engine that never had a main process.
    expect(last).not.toBeNull();
    expect(typeof last).toBe("function");
    expect(last?.()).toBe(false);
    expect(isStudioRuntimeReady()).toBe(false);
  });
});

describe("the registration retry is OWNED, and a teardown ends it", () => {
  /**
   * The retry exists because a failed dynamic import is usually transient. It
   * also outlives the teardown that should have ended it: before this, the
   * timer was never cleared, so it still fired, still ran a registration and a
   * reconciliation against a database that was about to stop, and could still
   * call `markStudioRuntimeReady` on a shutting-down process.
   */
  it("cancels the retry timer on teardown: it never fires at all", async () => {
    vi.useFakeTimers();
    try {
      // The first registration fails, which is what arms the retry.
      setStudioDispatchPreflight.mockImplementationOnce(() => {
        throw new Error("engine import failed");
      });
      const teardown = setupStudioSettlementBridge();
      await vi.waitFor(() => {
        expect(trace).toEqual(["preflight"]);
      });

      teardown();
      trace.length = 0;
      // Well past every retry attempt.
      await vi.advanceTimersByTimeAsync(60_000);

      // The timer is GONE, not merely neutered: no registration, no scan.
      expect(trace).toEqual([]);
      expect(reconcileAbandonedStudioDispatches).not.toHaveBeenCalled();
      expect(isStudioRuntimeReady()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a retry that DOES fire after a teardown still cannot open Studio", async () => {
    vi.useFakeTimers();
    try {
      setStudioDispatchPreflight.mockImplementationOnce(() => {
        throw new Error("engine import failed");
      });
      const teardown = setupStudioSettlementBridge();
      await vi.waitFor(() => {
        expect(trace).toEqual(["preflight"]);
      });
      // Let the retry get as far as its own callback, THEN tear down: this is
      // the interleaving a cleared timer alone does not cover, because the
      // registration and the scan are both awaited inside it.
      reconcileAbandonedStudioDispatches.mockImplementation(async () => {
        teardown();
        await Promise.resolve();
        return [];
      });
      await vi.advanceTimersByTimeAsync(6_000);
      await vi.advanceTimersByTimeAsync(0);

      // The epoch the retry holds is stale from the teardown onward, so the
      // readiness write it performs is refused.
      expect(isStudioRuntimeReady()).toBe(false);
      const readiness = studioReadiness();
      expect(readiness.ready).toBe(false);
      if (readiness.ready) return;
      expect(readiness.cause).toMatch(/shutting down/i);
    } finally {
      vi.useRealTimers();
    }
  });

  it("disposes the engine write-repair owner on teardown", async () => {
    const teardown = setupStudioSettlementBridge();
    await awaitStudioRuntimeReady();
    teardown();
    // Through the barrel's dynamic import, so it lands a microtask later.
    await vi.waitFor(() => {
      expect(disposeStudioWriteRepair).toHaveBeenCalled();
    });
  });
});

/**
 * THE COLD START, which is the shape of the owner's 2026-09-04 boot log.
 *
 * `whenReady` runs the bridge at t+0.3 s; the local Postgres only exists once
 * the RENDERER triggers compose, which finished at t+15.6 s on that machine.
 * The bridge's bounded retry was written for a transient failed import - three
 * attempts, 5 s apart - so it gave up at t+15.4 s, 265 ms before the database
 * came up, and Vex Studio reported UNAVAILABLE for the rest of the session.
 *
 * The wait is now unbounded and cancellable, and the bounded retry is spent
 * only on failures that happen after the database is ready.
 */
describe("the database is not up yet", () => {
  it("waits as long as the database takes, then opens Studio", async () => {
    vi.useFakeTimers();
    try {
      poolConfig = null;
      migrationsDone = false;
      const teardown = setupStudioSettlementBridge();
      await vi.advanceTimersByTimeAsync(0);
      // The fence is registered without a database, exactly as before.
      expect(trace).toEqual(["preflight"]);
      const registered = setStudioDispatchPreflight.mock.calls[0]?.[0] as
        | (() => boolean)
        | undefined;
      expect(registered?.()).toBe(false);

      // Twenty seconds of a database that is still starting: the old bound
      // would have given up at 15 s and logged "stays unavailable this session".
      await vi.advanceTimersByTimeAsync(20_000);
      expect(isStudioRuntimeReady()).toBe(false);
      expect(repairPendingStudioRefusal).not.toHaveBeenCalled();
      expect(reconcileAbandonedStudioDispatches).not.toHaveBeenCalled();

      // Compose finishes and the migrations land.
      databaseIsUp();
      await vi.advanceTimersByTimeAsync(1_000);

      expect(isStudioRuntimeReady()).toBe(true);
      expect(trace).toEqual(["preflight", "reconcile", "reconcile_unstarted"]);
      expect(registered?.()).toBe(true);
      teardown();
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * THE RETRY WAITS TOO, which is the other half of the owner's boot log.
   *
   * A registration that fails once and succeeds on the retry used to go
   * STRAIGHT to the database work: the retry spent its bounded budget at 5, 10
   * and 15 s against a database compose had not started, and Studio was
   * declared unavailable for the session 265 ms before it came up. Every
   * registration path now funnels through the same unbounded wait, so the
   * bounded budget is only ever spent on failures that happen after the
   * database is ready.
   */
  it("makes the RETRY path wait for the database too", async () => {
    vi.useFakeTimers();
    try {
      poolConfig = null;
      migrationsDone = false;
      // The first registration fails, which is what arms the retry.
      setStudioDispatchPreflight.mockImplementationOnce(() => {
        throw new Error("engine import failed");
      });
      const teardown = setupStudioSettlementBridge();
      await vi.advanceTimersByTimeAsync(0);
      expect(trace).toEqual(["preflight"]);

      // The retry fires at 5 s and registers successfully, and then WAITS: the
      // database is twenty seconds away.
      await vi.advanceTimersByTimeAsync(20_000);
      expect(trace).toEqual(["preflight", "preflight"]);
      expect(repairPendingStudioRefusal).not.toHaveBeenCalled();
      expect(reconcileAbandonedStudioDispatches).not.toHaveBeenCalled();
      expect(isStudioRuntimeReady()).toBe(false);

      databaseIsUp();
      await vi.advanceTimersByTimeAsync(1_000);

      expect(isStudioRuntimeReady()).toBe(true);
      // No unlock, no recovery pass: the wait itself finished the boot.
      expect(repairPendingStudioRefusal).toHaveBeenCalledTimes(1);
      // And the bounded budget is untouched by the wait, so it is still there
      // for a genuinely transient post-database failure.
      const { log: bridgeLog } = await import("../../logger/index.js");
      expect(
        vi
          .mocked(bridgeLog.error)
          .mock.calls.some((call) => String(call[0]).includes("bounded retries")),
      ).toBe(false);
      teardown();
    } finally {
      vi.useRealTimers();
    }
  });

  it("logs the wait ONCE, however many times it polls", async () => {
    vi.useFakeTimers();
    try {
      poolConfig = null;
      migrationsDone = false;
      const teardown = setupStudioSettlementBridge();
      await vi.advanceTimersByTimeAsync(10_000);
      const { log } = await import("../../logger/index.js");
      const waitLines = vi
        .mocked(log.info)
        .mock.calls.filter((call) => String(call[0]).includes("waiting for the database"));
      expect(waitLines).toHaveLength(1);
      teardown();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a teardown during the wait ABORTS it, and Studio never opens", async () => {
    vi.useFakeTimers();
    try {
      poolConfig = null;
      migrationsDone = false;
      const teardown = setupStudioSettlementBridge();
      await vi.advanceTimersByTimeAsync(2_000);
      teardown();

      // The database comes up AFTER the process decided to go away. Nothing
      // must reach it, and nothing may mark a shutting-down process ready.
      databaseIsUp();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(isStudioRuntimeReady()).toBe(false);
      expect(repairPendingStudioRefusal).not.toHaveBeenCalled();
      expect(reconcileAbandonedStudioDispatches).not.toHaveBeenCalled();
      const readiness = studioReadiness();
      expect(readiness.ready).toBe(false);
      if (readiness.ready) return;
      expect(readiness.code).toBe("shutting_down");
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * AFTER the database is ready, a failure IS what the bounded retry was written
 * for. What changed is the end of that road: an exhausted retry no longer means
 * "unavailable this session", because the secret session asks the bridge to try
 * again on the next unlock and on the recovery pass it already runs.
 */
describe("a failure after the database is ready", () => {
  it("retries three times, then hands the re-entry to the next unlock", async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(repairPendingStudioRefusal).mockResolvedValue(false);
      const teardown = setupStudioSettlementBridge();
      await vi.advanceTimersByTimeAsync(0);
      expect(repairPendingStudioRefusal).toHaveBeenCalledTimes(1);

      // Three retries, 5 s apart, and then it stops rather than spinning.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(repairPendingStudioRefusal).toHaveBeenCalledTimes(4);
      expect(isStudioRuntimeReady()).toBe(false);
      const { log } = await import("../../logger/index.js");
      expect(vi.mocked(log.error).mock.calls.some((call) =>
        String(call[0]).includes("bounded retries"),
      )).toBe(true);

      // The unlock re-entry: whatever was transient has passed.
      vi.mocked(repairPendingStudioRefusal).mockResolvedValue(true);
      requestStudioRuntimeRetry();
      await vi.advanceTimersByTimeAsync(0);
      expect(isStudioRuntimeReady()).toBe(true);
      teardown();
    } finally {
      vi.useRealTimers();
    }
  });

  it("the re-entry is a no-op once Studio is ready, and after a teardown", async () => {
    const teardown = setupStudioSettlementBridge();
    await awaitStudioRuntimeReady();
    expect(isStudioRuntimeReady()).toBe(true);
    const callsWhenReady = vi.mocked(repairPendingStudioRefusal).mock.calls.length;
    requestStudioRuntimeRetry();
    await Promise.resolve();
    expect(repairPendingStudioRefusal).toHaveBeenCalledTimes(callsWhenReady);

    teardown();
    requestStudioRuntimeRetry();
    await Promise.resolve();
    expect(repairPendingStudioRefusal).toHaveBeenCalledTimes(callsWhenReady);
    expect(isStudioRuntimeReady()).toBe(false);
  });
});
