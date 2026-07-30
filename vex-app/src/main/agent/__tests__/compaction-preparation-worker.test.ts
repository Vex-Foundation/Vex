/**
 * compaction-preparation-worker supervisor tests (compaction v2).
 *
 * Deps are injected, so this exercises pure lifecycle logic without a real DB
 * or engine. Same gates the sibling workers are pinned on: nothing starts
 * before the DB url AND the schema probe are ready; it starts EXACTLY ONCE;
 * `stop()` is idempotent and tears down an executor even when the start tick
 * resolves after quit began.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import type { CompactionPreparationWorkerHandle } from "@vex-agent/engine/compaction/preparation-executor.js";

vi.mock("../../logger/index.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../../ipc/runtime/_ensure-engine-db-url.js", () => ({
  ensureEngineDbUrl: vi.fn(),
}));

const probeOwnerMock = vi.hoisted(() => vi.fn(async () => false));
vi.mock("../../database/compaction-preparation-db.js", () => ({
  probeCompactionPreparationsReady: probeOwnerMock,
}));

const { setupCompactionPreparationWorker } = await import(
  "../compaction-preparation-worker.js"
);

type FakeHandle = CompactionPreparationWorkerHandle & {
  readonly stop: ReturnType<typeof vi.fn<() => Promise<void>>>;
};

function makeHandle(): FakeHandle {
  return { stop: vi.fn(async () => {}) };
}

/** Flush the immediate (non-timer) startup tick's async chain. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 15));
}

afterEach(() => {
  vi.clearAllMocks();
  probeOwnerMock.mockResolvedValue(false);
});

describe("setupCompactionPreparationWorker supervisor", () => {
  it("does not start while the DB url is unavailable", async () => {
    const startExecutor = vi.fn(async () => makeHandle());
    const stop = setupCompactionPreparationWorker({
      ensureDbUrl: vi.fn(async () => ({ ok: false })),
      probeReady: vi.fn(async () => true),
      startExecutor,
      intervalMs: 20,
    });
    await flush();
    expect(startExecutor).not.toHaveBeenCalled();
    await stop();
  });

  it("does not start while the compaction_preparations schema is not ready", async () => {
    const startExecutor = vi.fn(async () => makeHandle());
    const stop = setupCompactionPreparationWorker({
      ensureDbUrl: vi.fn(async () => ({ ok: true })),
      probeReady: vi.fn(async () => false),
      startExecutor,
      intervalMs: 20,
    });
    await flush();
    expect(startExecutor).not.toHaveBeenCalled();
    await stop();
  });

  it("defaults to the OWNER's probe — `probeCompactionPreparationsReady`", async () => {
    // The wiring is the point: with no `probeReady` override the supervisor
    // must consult `main/database/compaction-preparation-db.ts`, which itself
    // fails closed on an unreachable DB or an unapplied migration 058.
    probeOwnerMock.mockResolvedValueOnce(true);
    const startExecutor = vi.fn(async () => makeHandle());
    const stop = setupCompactionPreparationWorker({
      ensureDbUrl: vi.fn(async () => ({ ok: true })),
      startExecutor,
      intervalMs: 20,
    });
    await flush();
    expect(probeOwnerMock).toHaveBeenCalled();
    expect(startExecutor).toHaveBeenCalledTimes(1);
    await stop();
  });

  it("stays idle when the owner's probe reports the schema is not ready", async () => {
    probeOwnerMock.mockResolvedValue(false);
    const startExecutor = vi.fn(async () => makeHandle());
    const stop = setupCompactionPreparationWorker({
      ensureDbUrl: vi.fn(async () => ({ ok: true })),
      startExecutor,
      intervalMs: 20,
    });
    await flush();
    expect(startExecutor).not.toHaveBeenCalled();
    await stop();
  });

  it("starts exactly once and then stops polling", async () => {
    const startExecutor = vi.fn(async () => makeHandle());
    const probeReady = vi.fn(async () => true);
    const stop = setupCompactionPreparationWorker({
      ensureDbUrl: vi.fn(async () => ({ ok: true })),
      probeReady,
      startExecutor,
      intervalMs: 5,
    });
    await flush();
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(startExecutor).toHaveBeenCalledTimes(1);
    const probeCallsAfterStart = probeReady.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(probeReady.mock.calls.length).toBe(probeCallsAfterStart);
    await stop();
  });

  it("stops a started executor, idempotently", async () => {
    const handle = makeHandle();
    const stop = setupCompactionPreparationWorker({
      ensureDbUrl: vi.fn(async () => ({ ok: true })),
      probeReady: vi.fn(async () => true),
      startExecutor: vi.fn(async () => handle),
      intervalMs: 20,
    });
    await flush();

    await stop();
    await stop();
    expect(handle.stop).toHaveBeenCalledTimes(1);
  });

  it("tears down an executor whose start resolved after quit began", async () => {
    const handle = makeHandle();
    // The executor body runs synchronously, so `release` is always assigned
    // before the first await — but TS narrows the closure write away, hence the
    // explicit holder.
    const releaseHolder: { fn: () => void } = { fn: () => {} };
    const started = new Promise<void>((resolve) => {
      releaseHolder.fn = resolve;
    });
    const startExecutor = vi.fn(async (): Promise<FakeHandle> => {
      await started;
      return handle;
    });
    const stop = setupCompactionPreparationWorker({
      ensureDbUrl: vi.fn(async () => ({ ok: true })),
      probeReady: vi.fn(async () => true),
      startExecutor,
      intervalMs: 20,
    });
    await flush();

    const stopping = stop();
    await flush();
    releaseHolder.fn();
    await stopping;

    // Quit must never leave a live worker behind a slow start.
    expect(handle.stop).toHaveBeenCalledTimes(1);
  });
});
