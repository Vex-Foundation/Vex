/**
 * Pins the exit-watch poll loop's sequencing and failure behaviour.
 *
 * The worker owns no business logic: every side effect (loading positions,
 * pricing, emitting alerts, persisting peaks) is injected, and the wrapper only
 * sequences them. It deliberately does NOT execute anything — `emitAlert` is
 * the seam, and surfacing an alert is where this subsystem's responsibility
 * ends.
 *
 * Loop discipline mirrors the existing regime worker: a non-reentrant
 * `setTimeout` chain (never an overlapping `setInterval`), an immediate first
 * tick, a tick that throws being routed to `onError` rather than killing the
 * loop, and an idempotent teardown that awaits an in-flight tick.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ExitConfig } from "../../../../vex-agent/engine/exit/exit-rules.js";
import type { WatchInputPosition } from "../../../../vex-agent/engine/exit/watch-cycle.js";
import {
  runExitWatchTick,
  setupExitWatchWorker,
  type ExitWatchWorkerDeps,
} from "../../../../vex-agent/engine/exit/watch-worker.js";

const NOW = 1_700_000_000_000;

const CONFIG: ExitConfig = {
  takeProfitLadder: [{ multiple: 2, sellFraction: 0.5 }],
  stopLossPct: 0.35,
  trailingStopPct: 0.25,
  timeStopMinutes: 120,
  timeStopFlatBandPct: 0.15,
};

const POSITION: WatchInputPosition = {
  token: "0xtoken",
  entryPriceUsd: 1,
  amountTokens: 1_000,
  openedAtMs: NOW,
  consumedRungs: [],
  priorPeakPriceUsd: 1,
};

function deps(overrides: Partial<ExitWatchWorkerDeps> = {}): ExitWatchWorkerDeps {
  return {
    getOpenPositions: vi.fn().mockResolvedValue([POSITION]),
    priceOf: vi.fn().mockReturnValue(2),
    emitAlert: vi.fn(),
    savePeak: vi.fn(),
    config: CONFIG,
    now: () => NOW,
    ...overrides,
  };
}

describe("runExitWatchTick", () => {
  it("loads positions, evaluates them, then emits and persists per position", async () => {
    const d = deps();

    const alerts = await runExitWatchTick(d);

    expect(d.getOpenPositions).toHaveBeenCalledTimes(1);
    expect(alerts).toHaveLength(1);
    expect(d.emitAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        token: "0xtoken",
        decisions: [expect.objectContaining({ kind: "take_profit" })],
      }),
    );
    expect(d.savePeak).toHaveBeenCalledWith("0xtoken", 2);
  });

  it("emits an alert carrying no decisions when nothing fires", async () => {
    const d = deps({ priceOf: vi.fn().mockReturnValue(1.1) });

    await runExitWatchTick(d);

    expect(d.emitAlert).toHaveBeenCalledWith(
      expect.objectContaining({ decisions: [] }),
    );
  });

  it("uses the injected clock rather than the ambient wall clock", async () => {
    const now = vi.fn().mockReturnValue(NOW);
    await runExitWatchTick(deps({ now }));

    expect(now).toHaveBeenCalled();
  });

  it("keeps sweeping when one savePeak fails, routing the error to onError", async () => {
    const savePeak = vi
      .fn()
      .mockRejectedValueOnce(new Error("db down"))
      .mockResolvedValue(undefined);
    const onError = vi.fn();
    const emitAlert = vi.fn();

    await runExitWatchTick(
      deps({
        getOpenPositions: vi
          .fn()
          .mockResolvedValue([
            { ...POSITION, token: "A" },
            { ...POSITION, token: "B" },
          ]),
        savePeak,
        onError,
        emitAlert,
      }),
    );

    expect(emitAlert).toHaveBeenCalledTimes(2);
    expect(savePeak).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("does nothing but return when there are no open positions", async () => {
    const d = deps({ getOpenPositions: vi.fn().mockResolvedValue([]) });

    await expect(runExitWatchTick(d)).resolves.toEqual([]);
    expect(d.emitAlert).not.toHaveBeenCalled();
    expect(d.savePeak).not.toHaveBeenCalled();
  });
});

describe("setupExitWatchWorker", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs a first tick immediately without waiting for the interval", async () => {
    const d = deps();
    const stop = setupExitWatchWorker(d);
    await vi.advanceTimersByTimeAsync(0);

    expect(d.getOpenPositions).toHaveBeenCalledTimes(1);
    await stop();
  });

  it("keeps ticking on the configured cadence", async () => {
    const d = deps({ pollMs: 1_000 });
    const stop = setupExitWatchWorker(d);

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(d.getOpenPositions).toHaveBeenCalledTimes(3);
    await stop();
  });

  it("survives a throwing tick and reports it to onError", async () => {
    const onError = vi.fn();
    const getOpenPositions = vi
      .fn()
      .mockRejectedValueOnce(new Error("load failed"))
      .mockResolvedValue([POSITION]);

    const stop = setupExitWatchWorker(deps({ pollMs: 1_000, getOpenPositions, onError }));

    await vi.advanceTimersByTimeAsync(0);
    expect(onError).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(getOpenPositions).toHaveBeenCalledTimes(2);

    await stop();
  });

  it("never overlaps ticks — a slow tick delays the next one", async () => {
    let release: (() => void) | undefined;
    const getOpenPositions = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve([]);
        }),
    );

    const stop = setupExitWatchWorker(deps({ pollMs: 1_000, getOpenPositions }));
    await vi.advanceTimersByTimeAsync(0);

    // Tick 1 is still in flight; advancing well past the interval must not
    // start a second one.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(getOpenPositions).toHaveBeenCalledTimes(1);

    release?.();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(getOpenPositions).toHaveBeenCalledTimes(2);

    // Release tick 2 as well: teardown awaits the in-flight tick, so leaving it
    // pending would hang stop() forever.
    release?.();
    await stop();
  });

  it("stops cleanly and is safe to call twice", async () => {
    const d = deps({ pollMs: 1_000 });
    const stop = setupExitWatchWorker(d);
    await vi.advanceTimersByTimeAsync(0);

    await stop();
    await stop();

    const callsAfterStop = (d.getOpenPositions as ReturnType<typeof vi.fn>).mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);

    expect(d.getOpenPositions).toHaveBeenCalledTimes(callsAfterStop);
  });
});
