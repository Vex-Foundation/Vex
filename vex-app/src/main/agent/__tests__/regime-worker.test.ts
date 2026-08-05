/**
 * regime-worker supervisor tests (S6b §9).
 *
 * Deps are injected, so this exercises pure lifecycle logic without a real DB or
 * engine. Mirrors memory-manager-worker.test.ts: the worker does NOT start until
 * DB url + regime_snapshots schema are ready; it starts EXACTLY ONCE; `stop()`
 * is non-reentrant and tears down a worker even if `stop()` races a
 * still-pending start tick.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../logger/index.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../../database/regime-db.js", () => ({
  probeRegimeSnapshotsReady: vi.fn(),
}));
vi.mock("../../ipc/runtime/_ensure-engine-db-url.js", () => ({
  ensureEngineDbUrl: vi.fn(),
}));
// Migrations are the bootstrap gate every worker now consults; these tests are
// about the LIFECYCLE past it. `migrations-gate.test.ts` owns the gate itself.
vi.mock("../../database/migrations-applied.js", () => ({
  migrationsApplied: () => true,
}));

const { setupRegimeWorker } = await import("../regime-worker.js");

interface FakeHandle {
  readonly stop: ReturnType<typeof vi.fn>;
}
function makeHandle(): FakeHandle {
  return { stop: vi.fn(async () => {}) };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 15));
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("setupRegimeWorker supervisor", () => {
  it("does not start the worker while the DB url is unavailable", async () => {
    const startWorker = vi.fn(async () => makeHandle());
    const stop = setupRegimeWorker({
      ensureDbUrl: vi.fn(async () => ({ ok: false })),
      probeReady: vi.fn(async () => true),
      startWorker,
      intervalMs: 20,
    });
    await flush();
    expect(startWorker).not.toHaveBeenCalled();
    await stop();
  });

  it("does not start the worker while the regime_snapshots schema is not ready", async () => {
    const startWorker = vi.fn(async () => makeHandle());
    const probeReady = vi.fn(async () => false);
    const stop = setupRegimeWorker({
      ensureDbUrl: vi.fn(async () => ({ ok: true })),
      probeReady,
      startWorker,
      intervalMs: 20,
    });
    await flush();
    expect(probeReady).toHaveBeenCalled();
    expect(startWorker).not.toHaveBeenCalled();
    await stop();
  });

  it("starts the worker exactly once when DB + schema become ready", async () => {
    const handle = makeHandle();
    const startWorker = vi.fn(async () => handle);
    const stop = setupRegimeWorker({
      ensureDbUrl: vi.fn(async () => ({ ok: true })),
      probeReady: vi.fn(async () => true),
      startWorker,
      intervalMs: 20,
    });

    await flush();
    expect(startWorker).toHaveBeenCalledTimes(1);

    await new Promise((resolve) => setTimeout(resolve, 70));
    expect(startWorker).toHaveBeenCalledTimes(1);

    await stop();
    expect(handle.stop).toHaveBeenCalledTimes(1);
  });

  it("stop() awaits the worker handle stop and is idempotent", async () => {
    const handle = makeHandle();
    const stop = setupRegimeWorker({
      ensureDbUrl: vi.fn(async () => ({ ok: true })),
      probeReady: vi.fn(async () => true),
      startWorker: vi.fn(async () => handle),
      intervalMs: 20,
    });
    await flush();
    await stop();
    expect(handle.stop).toHaveBeenCalledTimes(1);
    await stop();
    expect(handle.stop).toHaveBeenCalledTimes(1);
  });

  it("does not leave a live worker if stop() races a pending start tick", async () => {
    const handle = makeHandle();
    let releaseStart: (() => void) | null = null;
    const startWorker = vi.fn(
      () =>
        new Promise<FakeHandle>((resolve) => {
          releaseStart = () => resolve(handle);
        }),
    );
    const stop = setupRegimeWorker({
      ensureDbUrl: vi.fn(async () => ({ ok: true })),
      probeReady: vi.fn(async () => true),
      startWorker,
      intervalMs: 1000,
    });

    await flush();
    expect(startWorker).toHaveBeenCalledTimes(1);

    const stopPromise = stop();
    if (releaseStart === null) throw new Error("start never reached");
    releaseStart();
    await stopPromise;

    expect(handle.stop).toHaveBeenCalledTimes(1);
  });
});
