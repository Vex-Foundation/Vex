/**
 * compact-worker supervisor tests (stage 7-1).
 *
 * Deps are injected, so this exercises pure lifecycle logic without a real
 * DB or engine. Heavy/electron imports reached transitively by the module
 * (logger, DB probe, db-url helper) are mocked since the injected deps stand
 * in for them.
 *
 * Pins Codex's gates: the executor does NOT start until DB url + schema are
 * ready; it starts EXACTLY ONCE; `stop()` is non-reentrant and tears down an
 * executor even if `stop()` races a still-pending start tick.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../logger/index.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../../database/compaction-db.js", () => ({
  probeCompactJobsReady: vi.fn(),
}));
vi.mock("../../ipc/runtime/_ensure-engine-db-url.js", () => ({
  ensureEngineDbUrl: vi.fn(),
}));
// Migrations are the bootstrap gate every worker now consults; these tests are
// about the LIFECYCLE past it. `migrations-gate.test.ts` owns the gate itself.
vi.mock("../../database/migrations-applied.js", () => ({
  migrationsApplied: () => true,
}));

const { setupCompactWorker } = await import("../compact-worker.js");

interface FakeHandle {
  readonly stop: ReturnType<typeof vi.fn>;
}
function makeHandle(): FakeHandle {
  return { stop: vi.fn(async () => {}) };
}

// Flush the immediate (non-timer) startup tick's async chain.
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 15));
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("setupCompactWorker supervisor", () => {
  it("does not start the executor while the DB url is unavailable", async () => {
    const startExecutor = vi.fn(async () => makeHandle());
    const stop = setupCompactWorker({
      ensureDbUrl: vi.fn(async () => ({ ok: false })),
      probeReady: vi.fn(async () => true),
      startExecutor,
      intervalMs: 20,
    });
    await flush();
    expect(startExecutor).not.toHaveBeenCalled();
    await stop();
  });

  it("does not start the executor while the compact_jobs schema is not ready", async () => {
    const startExecutor = vi.fn(async () => makeHandle());
    const probeReady = vi.fn(async () => false);
    const stop = setupCompactWorker({
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
    const stop = setupCompactWorker({
      ensureDbUrl: vi.fn(async () => ({ ok: true })),
      probeReady: vi.fn(async () => true),
      startExecutor,
      intervalMs: 20,
    });

    await flush();
    expect(startExecutor).toHaveBeenCalledTimes(1);

    // Later interval ticks must not start a second executor.
    await new Promise((resolve) => setTimeout(resolve, 70));
    expect(startExecutor).toHaveBeenCalledTimes(1);

    await stop();
    expect(handle.stop).toHaveBeenCalledTimes(1);
  });

  it("stop() awaits the executor handle stop and is idempotent", async () => {
    const handle = makeHandle();
    const stop = setupCompactWorker({
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
    const stop = setupCompactWorker({
      ensureDbUrl: vi.fn(async () => ({ ok: true })),
      probeReady: vi.fn(async () => true),
      startExecutor,
      intervalMs: 1000,
    });

    await flush(); // tick reaches startExecutor() and suspends on its promise
    expect(startExecutor).toHaveBeenCalledTimes(1);

    const stopPromise = stop(); // quit begins while start is still pending
    if (releaseStart === null) throw new Error("start never reached");
    releaseStart(); // now the executor resolves
    await stopPromise;

    // The freshly-created executor must have been torn down.
    expect(handle.stop).toHaveBeenCalledTimes(1);
  });
});
