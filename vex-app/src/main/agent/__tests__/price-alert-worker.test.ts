/**
 * price-alert-worker supervisor tests (F01).
 *
 * Deps are injected, so this exercises pure lifecycle logic without a real DB
 * or engine. Mirrors sync-worker.test.ts.
 *
 * Pins: the poller does NOT start until the DB url, migrations and the
 * price_alerts schema are ready; it starts EXACTLY ONCE; `stop()` is
 * idempotent and tears down a poller even if it races a still-pending start
 * tick. Like the sync worker there is NO provider gate and NO vault gate: the
 * poller reads public prices only.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import type { PriceAlertExecutorHandle } from "@vex-agent/alerts/price-alert-executor.js";

vi.mock("../../logger/index.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../../database/price-alerts-db.js", () => ({
  probePriceAlertsReady: vi.fn(),
}));
vi.mock("../../database/engine-db-readiness.js", () => ({
  ensureEngineDbUrl: vi.fn(),
}));
const migrations = vi.hoisted(() => ({ applied: true }));
vi.mock("../../database/migrations-applied.js", () => ({
  migrationsApplied: () => migrations.applied,
}));

const { setupPriceAlertWorker } = await import("../price-alert-worker.js");

function makeHandle() {
  const stop = vi.fn(async () => {});
  const handle: PriceAlertExecutorHandle = { stop };
  return { handle, stop };
}

// Flush the immediate (non-timer) startup tick's async chain.
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 15));
}

afterEach(() => {
  vi.clearAllMocks();
  migrations.applied = true;
});

describe("setupPriceAlertWorker supervisor", () => {
  it("does not start the poller while the DB url is unavailable", async () => {
    const startExecutor = vi.fn(async () => makeHandle().handle);
    const stop = setupPriceAlertWorker({
      ensureDbUrl: vi.fn(async () => ({ ok: false })),
      probeReady: vi.fn(async () => true),
      startExecutor,
      intervalMs: 20,
    });
    await flush();
    expect(startExecutor).not.toHaveBeenCalled();
    await stop();
  });

  it("issues no probe while migrations are pending", async () => {
    migrations.applied = false;
    const probeReady = vi.fn(async () => true);
    const startExecutor = vi.fn(async () => makeHandle().handle);
    const stop = setupPriceAlertWorker({
      ensureDbUrl: vi.fn(async () => ({ ok: true })),
      probeReady,
      startExecutor,
      intervalMs: 20,
    });
    await flush();
    expect(probeReady).not.toHaveBeenCalled();
    expect(startExecutor).not.toHaveBeenCalled();
    await stop();
  });

  it("does not start the poller while the price_alerts schema is not ready", async () => {
    const startExecutor = vi.fn(async () => makeHandle().handle);
    const probeReady = vi.fn(async () => false);
    const stop = setupPriceAlertWorker({
      ensureDbUrl: vi.fn(async () => ({ ok: true })),
      probeReady,
      startExecutor,
      intervalMs: 20,
    });
    await flush();
    expect(probeReady).toHaveBeenCalled();
    expect(startExecutor).not.toHaveBeenCalled();
    await stop();
  });

  it("starts the poller exactly once when DB + schema become ready", async () => {
    const { handle, stop: handleStop } = makeHandle();
    const startExecutor = vi.fn(async () => handle);
    const stop = setupPriceAlertWorker({
      ensureDbUrl: vi.fn(async () => ({ ok: true })),
      probeReady: vi.fn(async () => true),
      startExecutor,
      intervalMs: 20,
    });

    await flush();
    expect(startExecutor).toHaveBeenCalledTimes(1);

    // Later interval ticks must not start a second poller.
    await new Promise((resolve) => setTimeout(resolve, 70));
    expect(startExecutor).toHaveBeenCalledTimes(1);

    await stop();
    expect(handleStop).toHaveBeenCalledTimes(1);
  });

  it("stop() awaits the poller's stop and is idempotent", async () => {
    const { handle, stop: handleStop } = makeHandle();
    const stop = setupPriceAlertWorker({
      ensureDbUrl: vi.fn(async () => ({ ok: true })),
      probeReady: vi.fn(async () => true),
      startExecutor: vi.fn(async () => handle),
      intervalMs: 20,
    });
    await flush();
    await stop();
    expect(handleStop).toHaveBeenCalledTimes(1);
    await stop();
    expect(handleStop).toHaveBeenCalledTimes(1);
  });

  it("does not leave a live poller if stop() races a pending start tick", async () => {
    const { handle, stop: handleStop } = makeHandle();
    // A holder, not a `let`: the assignment happens inside the promise
    // executor, which control-flow narrowing cannot see.
    const gate: { release: (() => void) | null } = { release: null };
    const startExecutor = vi.fn(
      () =>
        new Promise<PriceAlertExecutorHandle>((resolve) => {
          gate.release = () => resolve(handle);
        }),
    );
    const stop = setupPriceAlertWorker({
      ensureDbUrl: vi.fn(async () => ({ ok: true })),
      probeReady: vi.fn(async () => true),
      startExecutor,
      intervalMs: 1000,
    });

    await flush(); // tick reaches startExecutor() and suspends on its promise
    expect(startExecutor).toHaveBeenCalledTimes(1);

    const stopPromise = stop(); // quit begins while start is still pending
    if (gate.release === null) throw new Error("start never reached");
    gate.release();
    await stopPromise;

    expect(handleStop).toHaveBeenCalledTimes(1);
  });
});
