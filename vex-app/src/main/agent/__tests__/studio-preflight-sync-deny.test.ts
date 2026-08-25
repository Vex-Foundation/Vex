/**
 * THE DISPATCH PREFLIGHT IS SET TO DENY SYNCHRONOUSLY, at bridge setup.
 *
 * The defect: the engine's preflight slot lived next to the database repo, so
 * main could only reach it through a DYNAMIC import - fallible and
 * asynchronous. Between main's modules loading and that registration landing,
 * NOTHING was registered, and the engine's default with nothing registered is
 * ALLOW. A registration that FAILED left ALLOW in place for the whole session
 * while main's own readiness flag said the opposite: the two enforcement points
 * that are supposed to fail closed independently disagreed, and the one the
 * engine actually consults was the one saying yes.
 *
 * The registry is now an import-free module, so the deny is a plain static
 * call. This file reads the REAL registry - no mock of it anywhere - because a
 * mocked registry cannot prove what the engine would see.
 *
 * The engine-side default (nothing registered means ALLOW, which is a headless
 * engine's correct behaviour) is pinned next to the dispatch path itself, in
 * `src/__tests__/vex-agent/engine/core/approval-runtime/studio/dispatch.test.ts`
 * ("dispatches normally when nothing registered a preflight").
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../../logger/index.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../../studio/approval-refusals.js", () => ({
  repairPendingStudioRefusal: vi.fn().mockResolvedValue(true),
}));
vi.mock("../../secrets/session.js", () => ({
  isSecretSessionUnlocked: () => true,
  isStudioSessionTransitionInProgress: () => false,
  isStudioDispatchPoisoned: () => false,
}));

/**
 * The engine barrel is mocked ONLY to keep the database client out of this
 * test's graph, and its async initialization NEVER completes: that is the
 * condition under test.
 */
const neverSettles = (): Promise<never> => new Promise<never>(() => {});
vi.mock("@vex-agent/engine/core/approval-runtime.js", () => ({
  setStudioDispatchPreflight: neverSettles,
  reconcileAbandonedStudioDispatches: neverSettles,
  announceStudioReconciliations: () => {},
  reconcileUnstartedStudioApprovals: neverSettles,
  announceStudioUnstartedRefusals: () => {},
  disposeStudioWriteRepair: () => {},
}));

const { setupStudioSettlementBridge } = await import(
  "../studio-settlement-bridge.js"
);
// THE REAL REGISTRY.
const { readStudioDispatchPreflight, setStudioDispatchPreflight } = await import(
  "@vex-agent/engine/core/approval-runtime/studio/dispatch-preflight.js"
);
const { resetStudioReadinessForTests } = await import(
  "../../studio/readiness.js"
);

beforeEach(() => {
  vi.clearAllMocks();
  resetStudioReadinessForTests();
  // The headless starting point: nothing registered.
  setStudioDispatchPreflight(null);
});

afterEach(() => {
  setStudioDispatchPreflight(null);
  resetStudioReadinessForTests();
});

describe("the preflight registry", () => {
  it("ALLOWS by default, for a headless engine that never had a main process", () => {
    // `null` means "no main process is speaking", never "deny": the durable CAS
    // is the authority in every case but a failed generation advance, and that
    // condition cannot arise without a main process at all.
    expect(readStudioDispatchPreflight()).toBeNull();
  });

  it("DENIES the moment bridge setup returns, even though async init never runs", () => {
    const teardown = setupStudioSettlementBridge();
    try {
      // SYNCHRONOUS: nothing is awaited between the call above and this line,
      // and the mocked barrel's registration is a promise that never settles.
      const preflight = readStudioDispatchPreflight();
      expect(preflight).not.toBeNull();
      expect(typeof preflight).toBe("function");
      expect(preflight?.()).toBe(false);
    } finally {
      teardown();
    }
  });

  it("still DENIES after the initialization has had every chance to fail", async () => {
    const teardown = setupStudioSettlementBridge();
    try {
      // Drain the microtask queue: the registration is still outstanding and
      // will never land, which is exactly the session-long window that used to
      // sit at default-ALLOW.
      await Promise.resolve();
      await Promise.resolve();
      expect(readStudioDispatchPreflight()?.()).toBe(false);
    } finally {
      teardown();
    }
  });

  it("DENIES after teardown, and never restores the default", () => {
    const teardown = setupStudioSettlementBridge();
    teardown();
    const preflight = readStudioDispatchPreflight();
    // NOT `null`. Restoring the engine default on a shutting-down main would
    // open the fence at the worst possible moment.
    expect(preflight).not.toBeNull();
    expect(preflight?.()).toBe(false);
  });
});
