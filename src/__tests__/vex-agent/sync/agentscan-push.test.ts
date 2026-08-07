/**
 * AgentScan seconds-level PUSH lane — scheduling invariants (task-2-brief AC1).
 *
 * These are the properties that make it safe to hang a debounced, in-flight
 * drain off `pendingActivityBus`, a bus whose producers fire synchronously on
 * the money path:
 *
 * 1. TRAILING DEBOUNCE. A burst of triggers while idle collapses to one run,
 *    fired only after the quiet window.
 * 2. SINGLE-FLIGHT + DIRTY-FLAG RERUN. A trigger that lands mid-run never
 *    starts a second concurrent run; it schedules exactly one follow-up,
 *    which starts the moment the in-flight run finishes.
 * 3. SILENCE. No trigger, no run — this lane never polls on its own.
 * 4. STOP IS TERMINAL. Nothing scheduled or in flight survives stop(), and no
 *    later trigger revives it.
 * 5. CONTAINMENT. A rejecting `run` is swallowed (logged, not thrown) and
 *    does not poison the next trigger. Vitest fails the test itself on an
 *    unhandled rejection, so the absence of one is the proof.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@utils/logger.js", () => {
  const stub = { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() };
  return { default: stub, logger: stub };
});

import logger from "@utils/logger.js";
import { startAgentscanPush } from "../../../vex-agent/sync/agentscan-push.js";
import {
  pendingActivityBus,
  type PendingActivityEvent,
} from "../../../vex-agent/events/pending-activity-bus.js";

const DEBOUNCE_MS = 2000;

function armedEvent(): PendingActivityEvent {
  return {
    type: "sync.activity.pending",
    kind: "armed",
    activityId: 1,
    chainFamily: "eip155",
    chainId: 8453,
    lane: "onchain",
    status: null,
    occurredAt: new Date().toISOString(),
  };
}

function resolvedEvent(): PendingActivityEvent {
  return {
    type: "sync.activity.pending",
    kind: "resolved",
    activityId: 1,
    chainFamily: "eip155",
    chainId: 8453,
    lane: "onchain",
    status: "confirmed",
    occurredAt: new Date().toISOString(),
  };
}

/** A promise this test controls the settlement of, without a non-null assertion. */
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolveFn: (value: T) => void = () => {};
  let rejectFn: (reason?: unknown) => void = () => {};
  const promise = new Promise<T>((resolve, reject) => {
    resolveFn = resolve;
    rejectFn = reject;
  });
  return { promise, resolve: resolveFn, reject: rejectFn };
}

describe("agentscan push lane scheduling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    pendingActivityBus.clear();
  });

  afterEach(() => {
    pendingActivityBus.clear();
    vi.useRealTimers();
  });

  it("collapses a burst of triggers while idle into exactly one run, after the debounce window", async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    const stop = startAgentscanPush({ run, debounceMs: DEBOUNCE_MS });

    pendingActivityBus.emit(armedEvent());
    await vi.advanceTimersByTimeAsync(500);
    pendingActivityBus.emit(resolvedEvent());
    await vi.advanceTimersByTimeAsync(500);
    pendingActivityBus.emit(armedEvent());

    expect(run).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(run).toHaveBeenCalledTimes(1);

    stop();
  });

  it("performs no run when no trigger ever arrives", async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    const stop = startAgentscanPush({ run, debounceMs: DEBOUNCE_MS });

    await vi.advanceTimersByTimeAsync(10_000);
    expect(run).not.toHaveBeenCalled();

    stop();
  });

  it("runs exactly one follow-up when triggers land while a run is in flight", async () => {
    const first = deferred<void>();
    const run = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue(undefined);
    const stop = startAgentscanPush({ run, debounceMs: DEBOUNCE_MS });

    pendingActivityBus.emit(armedEvent());
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(run).toHaveBeenCalledTimes(1);

    // Three triggers land mid-flight — dirty-flag coalescing must produce
    // exactly one follow-up, not three.
    pendingActivityBus.emit(armedEvent());
    pendingActivityBus.emit(resolvedEvent());
    pendingActivityBus.emit(armedEvent());

    first.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(2);

    // The follow-up itself resolved with no further triggers: no third run.
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(run).toHaveBeenCalledTimes(2);

    stop();
  });

  it("never runs again after stop(), including a trigger already in the debounce window", async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    const stop = startAgentscanPush({ run, debounceMs: DEBOUNCE_MS });

    pendingActivityBus.emit(armedEvent());
    stop();

    pendingActivityBus.emit(armedEvent());
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS * 2);
    expect(run).not.toHaveBeenCalled();
  });

  it("unsubscribes from the bus on stop()", () => {
    const run = vi.fn().mockResolvedValue(undefined);
    expect(pendingActivityBus.size()).toBe(0);
    const stop = startAgentscanPush({ run, debounceMs: DEBOUNCE_MS });
    expect(pendingActivityBus.size()).toBe(1);
    stop();
    expect(pendingActivityBus.size()).toBe(0);
  });

  it("contains a rejecting run: no unhandled rejection, and the next trigger still runs", async () => {
    const run = vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValue(undefined);
    const stop = startAgentscanPush({ run, debounceMs: DEBOUNCE_MS });

    pendingActivityBus.emit(armedEvent());
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(logger.warn).toHaveBeenCalledTimes(1);

    pendingActivityBus.emit(armedEvent());
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(run).toHaveBeenCalledTimes(2);

    stop();
  });
});
