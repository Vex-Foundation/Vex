/**
 * memory-manager-worker supervisor tests (S4 §4/§10).
 *
 * Deps are injected, so this exercises pure lifecycle logic without a real DB or
 * engine. Mirrors compact-worker.test.ts / wake-worker.test.ts: the executor does
 * NOT start until DB url + memory_jobs schema are ready; it starts EXACTLY ONCE;
 * `stop()` is non-reentrant and tears down an executor even if `stop()` races a
 * still-pending start tick.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../logger/index.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../../database/memory-jobs-db.js", () => ({
  probeMemoryJobsReady: vi.fn(),
}));
vi.mock("../../ipc/runtime/_ensure-engine-db-url.js", () => ({
  ensureEngineDbUrl: vi.fn(),
}));
// Migrations are the bootstrap gate every worker now consults; these tests are
// about the LIFECYCLE past it. `migrations-gate.test.ts` owns the gate itself.
vi.mock("../../database/migrations-applied.js", () => ({
  migrationsApplied: () => true,
}));

const { setupMemoryManagerWorker } = await import("../memory-manager-worker.js");

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

describe("setupMemoryManagerWorker supervisor", () => {
  it("does not start the executor while the DB url is unavailable", async () => {
    const startExecutor = vi.fn(async () => makeHandle());
    const stop = setupMemoryManagerWorker({
      ensureDbUrl: vi.fn(async () => ({ ok: false })),
      probeReady: vi.fn(async () => true),
      startExecutor,
      intervalMs: 20,
    });
    await flush();
    expect(startExecutor).not.toHaveBeenCalled();
    await stop();
  });

  it("does not start the executor while the memory_jobs schema is not ready", async () => {
    const startExecutor = vi.fn(async () => makeHandle());
    const probeReady = vi.fn(async () => false);
    const stop = setupMemoryManagerWorker({
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

  it("starts the executor exactly once when DB + schema become ready", async () => {
    const handle = makeHandle();
    const startExecutor = vi.fn(async () => handle);
    const stop = setupMemoryManagerWorker({
      ensureDbUrl: vi.fn(async () => ({ ok: true })),
      probeReady: vi.fn(async () => true),
      startExecutor,
      intervalMs: 20,
    });

    await flush();
    expect(startExecutor).toHaveBeenCalledTimes(1);

    await new Promise((resolve) => setTimeout(resolve, 70));
    expect(startExecutor).toHaveBeenCalledTimes(1);

    await stop();
    expect(handle.stop).toHaveBeenCalledTimes(1);
  });

  it("stop() awaits the executor handle stop and is idempotent", async () => {
    const handle = makeHandle();
    const stop = setupMemoryManagerWorker({
      ensureDbUrl: vi.fn(async () => ({ ok: true })),
      probeReady: vi.fn(async () => true),
      startExecutor: vi.fn(async () => handle),
      intervalMs: 20,
    });
    await flush();
    await stop();
    expect(handle.stop).toHaveBeenCalledTimes(1);
    await stop();
    expect(handle.stop).toHaveBeenCalledTimes(1);
  });

  it("does not leave a live executor if stop() races a pending start tick", async () => {
    const handle = makeHandle();
    let releaseStart: (() => void) | null = null;
    const startExecutor = vi.fn(
      () =>
        new Promise<FakeHandle>((resolve) => {
          releaseStart = () => resolve(handle);
        }),
    );
    const stop = setupMemoryManagerWorker({
      ensureDbUrl: vi.fn(async () => ({ ok: true })),
      probeReady: vi.fn(async () => true),
      startExecutor,
      intervalMs: 1000,
    });

    await flush();
    expect(startExecutor).toHaveBeenCalledTimes(1);

    const stopPromise = stop();
    if (releaseStart === null) throw new Error("start never reached");
    releaseStart();
    await stopPromise;

    expect(handle.stop).toHaveBeenCalledTimes(1);
  });
});
