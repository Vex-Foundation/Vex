/**
 * Façade-surface guard for the wake-executor structural split (A-020).
 *
 * `src/vex-agent/engine/wake/executor.ts` was split into nested modules under
 * `./executor/` (deps, tick, claimed, auto-retry, provider) while the original
 * path stays a compatibility façade + lifecycle owner. This test pins the EXACT
 * public runtime surface so a later edit cannot silently drop, rename, or add an
 * export. The tick behavior is covered by `executor.test.ts`; here we assert
 * presence + runtime typeof + the exact export-key set, that type-only imports
 * of the exported types compile, and a CODEX-EXTRA fake-timer lifecycle guard
 * proving the self-scheduling setTimeout chain never overlaps an in-flight tick
 * and that stop() clears the pending timer + drains the active tick.
 */

import { describe, it, expect, vi, afterEach } from "vitest";

import * as executorFacade from "../../../../vex-agent/engine/wake/executor.js";

// Value re-exports — pinned for runtime typeof below.
import {
  tick,
  startWakeExecutor,
  isWakeProviderConfigured,
} from "../../../../vex-agent/engine/wake/executor.js";

// Type-only imports must compile against the façade re-exports. `tsc --noEmit`
// (run by the orchestrator) rejects any signature drift in these named types.
import type {
  ClaimedWakeOutcome,
  ClaimedWake,
  WakeDeps,
  WakeExecutorHandle,
  StartOptions,
} from "../../../../vex-agent/engine/wake/executor.js";
import type { DeadlineWatchdogDeps } from "../../../../vex-agent/engine/wake/deadline-watchdog.js";

// Reference the type-only imports so the bindings are not elided as unused; the
// assignment compiles only if the exported types are structurally as expected.
type _AssertTypes = [
  ClaimedWakeOutcome["kind"],
  ClaimedWake["wake"],
  WakeDeps["isProviderReady"],
  WakeExecutorHandle["stop"],
  StartOptions["intervalMs"],
];

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

/**
 * Deadline-watchdog deps for the sweep the executor now hosts. ALWAYS injected
 * in these tests — the production factory would reach the real DB.
 */
function makeDeadlineDeps(
  overrides: Partial<DeadlineWatchdogDeps> = {},
): DeadlineWatchdogDeps {
  return {
    listCandidateRuns: vi.fn().mockResolvedValue([]),
    resolveDeadlineMs: vi.fn(() => null),
    getLease: vi.fn().mockResolvedValue(null),
    casStopPastDeadline: vi.fn().mockResolvedValue(null),
    rejectPendingApprovals: vi.fn().mockResolvedValue(0),
    cancelPendingWakes: vi.fn().mockResolvedValue(0),
    setMissionFailed: vi.fn().mockResolvedValue(undefined),
    captureFinal: vi.fn().mockResolvedValue(undefined),
    emitControlState: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("wake executor façade — public surface", () => {
  it("exposes every expected runtime export with the correct typeof", () => {
    expect(typeof tick).toBe("function");
    expect(typeof startWakeExecutor).toBe("function");
    expect(typeof isWakeProviderConfigured).toBe("function");
  });

  it("named re-exports are identity-equal to the namespace import", () => {
    expect(executorFacade.tick).toBe(tick);
    expect(executorFacade.startWakeExecutor).toBe(startWakeExecutor);
    expect(executorFacade.isWakeProviderConfigured).toBe(isWakeProviderConfigured);
  });

  it("exports EXACTLY the expected runtime keys — no more, no less", () => {
    const keys = Object.keys(executorFacade).sort();
    expect(keys).toEqual(
      [
        "tick",
        "startWakeExecutor",
        "isWakeProviderConfigured",
      ].sort(),
    );
  });
});

describe("startWakeExecutor — self-scheduling lifecycle (fake timers)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not overlap ticks while inFlight is unresolved, and stop() clears the timer + drains the active tick", async () => {
    vi.useFakeTimers();

    // A claimDue we control: the first tick blocks on this deferred so the tick
    // stays in-flight and we can prove the chain never fires a second timer.
    let releaseClaim: (rows: never[]) => void = () => {};
    const claimGate = new Promise<never[]>((resolve) => {
      releaseClaim = resolve;
    });
    const claimDue = vi.fn().mockReturnValueOnce(claimGate).mockResolvedValue([]);
    const deps = makeDeps({ claimDue });

    const handle = startWakeExecutor({
      intervalMs: 2000,
      batchSize: 5,
      deps,
      deadlineDeps: makeDeadlineDeps(),
    });

    // Nothing runs until the initial timeout fires.
    expect(claimDue).not.toHaveBeenCalled();

    // Fire the initial timeout → first tick starts and blocks on claimGate.
    await vi.advanceTimersByTimeAsync(2000);
    expect(claimDue).toHaveBeenCalledTimes(1);

    // No overlap: advancing more time while the tick is still in-flight must
    // NOT start a second tick (the next timer is only armed in the finally).
    await vi.advanceTimersByTimeAsync(10_000);
    expect(claimDue).toHaveBeenCalledTimes(1);

    // stop() while the tick is active: it must clear any pending timer and
    // await the in-flight tick. We resolve the gate shortly after to prove the
    // returned promise only settles once the active tick drains.
    let stopResolved = false;
    const stopPromise = handle.stop().then(() => {
      stopResolved = true;
    });

    // stop() is awaiting the in-flight tick — not yet resolved.
    await Promise.resolve();
    expect(stopResolved).toBe(false);

    // Drain the active tick.
    releaseClaim([]);
    await stopPromise;
    expect(stopResolved).toBe(true);

    // After stop(): the stopped flag short-circuits any rescheduling, so even
    // if a timer had been armed, advancing time triggers no further ticks.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(claimDue).toHaveBeenCalledTimes(1);
  });
});

/**
 * The hard-deadline sweep rides this executor's existing timer rather than
 * standing up a second subsystem. These pin the hosting contract.
 */
describe("startWakeExecutor — hosted deadline sweep (fake timers)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("sweeps on the executor's timer, throttled to its own interval", async () => {
    vi.useFakeTimers();
    const deadlineDeps = makeDeadlineDeps();
    const handle = startWakeExecutor({
      intervalMs: 1000,
      deps: makeDeps(),
      deadlineDeps,
      deadlineSweepIntervalMs: 5000,
    });

    // First executor tick sweeps immediately.
    await vi.advanceTimersByTimeAsync(1000);
    expect(deadlineDeps.listCandidateRuns).toHaveBeenCalledTimes(1);

    // Three more 1s ticks fall inside the 5s sweep window — no extra sweeps.
    await vi.advanceTimersByTimeAsync(3000);
    expect(deadlineDeps.listCandidateRuns).toHaveBeenCalledTimes(1);

    // Past the window → sweeps again.
    await vi.advanceTimersByTimeAsync(3000);
    expect(deadlineDeps.listCandidateRuns).toHaveBeenCalledTimes(2);

    await handle.stop();
  });

  it("sweeps even when the inference provider is NOT ready", async () => {
    // `tick` is provider-gated because resuming needs inference. Stopping does
    // not — and an absent provider key is exactly what parks runs in
    // paused_error, so gating the sweep would disable enforcement precisely
    // when it matters.
    vi.useFakeTimers();
    const deadlineDeps = makeDeadlineDeps();
    const claimDue = vi.fn().mockResolvedValue([]);
    const handle = startWakeExecutor({
      intervalMs: 1000,
      deps: makeDeps({ claimDue, isProviderReady: vi.fn(() => false) }),
      deadlineDeps,
    });

    await vi.advanceTimersByTimeAsync(1000);

    expect(deadlineDeps.listCandidateRuns).toHaveBeenCalledTimes(1);
    expect(claimDue).not.toHaveBeenCalled();

    await handle.stop();
  });

  it("a sweep failure does not stop the wake tick from running", async () => {
    vi.useFakeTimers();
    const claimDue = vi.fn().mockResolvedValue([]);
    const handle = startWakeExecutor({
      intervalMs: 1000,
      deps: makeDeps({ claimDue }),
      deadlineDeps: makeDeadlineDeps({
        listCandidateRuns: vi.fn().mockRejectedValue(new Error("db down")),
      }),
    });

    await vi.advanceTimersByTimeAsync(1000);
    expect(claimDue).toHaveBeenCalledTimes(1);

    await handle.stop();
  });
});
