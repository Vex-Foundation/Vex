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
const { isStudioRuntimeReady, studioReadiness, resetStudioReadinessForTests } =
  await import("../../studio/readiness.js");
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
  reconcileAbandonedStudioDispatches.mockResolvedValue([]);
  reconcileUnstartedStudioApprovals.mockResolvedValue([]);
  vi.mocked(repairPendingStudioRefusal).mockResolvedValue(true);
});

afterEach(() => {
  resetStudioReadinessForTests();
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
