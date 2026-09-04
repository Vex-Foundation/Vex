/**
 * A1 — no engine worker issues SQL before migrations have run.
 *
 * ## The live failure this pins
 *
 * After compose-up the workers started at 22:21:53 while the schema was still
 * one migrate run behind, and the fast lane died twice a second on
 * `sync.fast_lane.cycle_failed: column "evm_claim_lease_until" does not exist`
 * until `ipc:vex:database:migrate` completed (`applied=3`) at 22:22:12.
 *
 * The per-worker `probeReady` did not catch it and could not: it proves ONE
 * TABLE exists, and the table did exist — it was the COLUMN a newer migration
 * adds that did not. So the gate is the process-wide fact
 * (`database/migrations-applied.ts`), consulted by every worker's start gate.
 *
 * Every supervisor is driven here rather than one representative: the defect is
 * "a worker that skipped the gate", so a worker missing the check must fail a
 * test, not pass one nobody wrote for it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let applied = false;

const logInfo = vi.fn();
vi.mock("../../logger/index.js", () => ({
  log: { info: (...a: unknown[]) => logInfo(...a), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../../database/migrations-applied.js", () => ({
  migrationsApplied: () => applied,
}));
vi.mock("../../database/engine-db-readiness.js", () => ({
  ensureEngineDbUrl: vi.fn(),
}));
vi.mock("../../database/wake-db.js", () => ({ probeLoopWakeReady: vi.fn() }));
vi.mock("../../database/sync-db.js", () => ({ probeProtocolSyncReady: vi.fn() }));
vi.mock("../../database/compaction-db.js", () => ({ probeCompactJobsReady: vi.fn() }));
vi.mock("../../database/compaction-preparation-db.js", () => ({
  probeCompactionPreparationsReady: vi.fn(),
}));
vi.mock("../../database/memory-jobs-db.js", () => ({ probeMemoryJobsReady: vi.fn() }));
vi.mock("../../database/regime-db.js", () => ({ probeRegimeSnapshotsReady: vi.fn() }));
vi.mock("../../database/tool-embeddings-db.js", () => ({ probeToolEmbeddingsReady: vi.fn() }));

const { setupWakeWorker } = await import("../wake-worker.js");
const { setupSyncWorker } = await import("../sync-worker.js");
const { setupCompactWorker } = await import("../compact-worker.js");
const { setupCompactionPreparationWorker } = await import(
  "../compaction-preparation-worker.js"
);
const { setupMemoryManagerWorker } = await import("../memory-manager-worker.js");
const { setupRegimeWorker } = await import("../regime-worker.js");
const { setupToolEmbeddingReconcileWorker } = await import(
  "../tool-embedding-reconcile-worker.js"
);

/** Flush the immediate (non-timer) startup tick's async chain. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 15));
}

/**
 * Each supervisor, reduced to what this test cares about: a spy that fires when
 * the worker would begin issuing SQL, and a start call whose other gates are
 * already open. `probeReady` is the ONE thing that must not even be consulted
 * before migrations — it is itself a query.
 */
interface WorkerCase {
  readonly label: string;
  readonly start: (deps: {
    work: () => Promise<never | { stop: () => Promise<void> }>;
    probeReady: () => Promise<boolean>;
    ensureDbUrl: () => Promise<{ readonly ok: boolean }>;
  }) => () => Promise<void>;
}

function handle(): { stop: () => Promise<void> } {
  return { stop: async () => {} };
}

const dbUrlReady = async (): Promise<{ readonly ok: boolean }> => ({ ok: true });

const WORKERS: readonly WorkerCase[] = [
  {
    label: "[wake-worker]",
    start: ({ work, probeReady, ensureDbUrl }) =>
      setupWakeWorker({ ensureDbUrl, probeReady, startExecutor: work as never, intervalMs: 20 }),
  },
  {
    label: "[sync-worker]",
    start: ({ work, probeReady, ensureDbUrl }) =>
      setupSyncWorker({ ensureDbUrl, probeReady, startExecutor: work as never, intervalMs: 20 }),
  },
  {
    label: "[compact-worker]",
    start: ({ work, probeReady, ensureDbUrl }) =>
      setupCompactWorker({ ensureDbUrl, probeReady, startExecutor: work as never, intervalMs: 20 }),
  },
  {
    label: "[compaction-prep-worker]",
    start: ({ work, probeReady, ensureDbUrl }) =>
      setupCompactionPreparationWorker({
        ensureDbUrl,
        probeReady,
        startExecutor: work as never,
        intervalMs: 20,
      }),
  },
  {
    label: "[memory-manager-worker]",
    start: ({ work, probeReady, ensureDbUrl }) =>
      setupMemoryManagerWorker({
        ensureDbUrl,
        probeReady,
        startExecutor: work as never,
        intervalMs: 20,
      }),
  },
  {
    label: "[regime-worker]",
    start: ({ work, probeReady, ensureDbUrl }) =>
      setupRegimeWorker({ ensureDbUrl, probeReady, startWorker: work as never, intervalMs: 20 }),
  },
  {
    label: "[tool-embedding-reconcile]",
    start: ({ work, probeReady, ensureDbUrl }) =>
      setupToolEmbeddingReconcileWorker({
        ensureDbUrl,
        probeReady,
        reconcile: work as never,
        intervalMs: 20,
      }),
  },
];

beforeEach(() => {
  applied = false;
  logInfo.mockClear();
});
afterEach(() => {
  vi.clearAllMocks();
});

describe.each(WORKERS)("$label start gate", ({ label, start }) => {
  it("issues NO SQL and names the wait while migrations are pending", async () => {
    const work = vi.fn(async () => handle());
    const probeReady = vi.fn(async () => true);

    const stop = start({ work, probeReady, ensureDbUrl: dbUrlReady });
    await flush();

    expect(work).not.toHaveBeenCalled();
    // The probe is itself a query — the gate is BEFORE it, not around the work.
    expect(probeReady).not.toHaveBeenCalled();
    expect(logInfo).toHaveBeenCalledWith(`${label} waiting to start: migrations pending`);

    await stop();
  });

  it("runs its normal cycle once migrations have completed", async () => {
    const work = vi.fn(async () => handle());
    const probeReady = vi.fn(async () => true);
    applied = true;

    const stop = start({ work, probeReady, ensureDbUrl: dbUrlReady });
    await flush();

    expect(probeReady).toHaveBeenCalled();
    expect(work).toHaveBeenCalledTimes(1);

    await stop();
  });

  it("still names the migration wait after an earlier database-url wait", async () => {
    // `warnWaitingOnce` used to latch on the FIRST reason ever logged, which
    // would have hidden this gate entirely on the ordinary boot where the DB url
    // resolves last.
    const work = vi.fn(async () => handle());
    let urlReady = false;

    const stop = start({
      work,
      probeReady: vi.fn(async () => true),
      ensureDbUrl: async () => ({ ok: urlReady }),
    });
    await flush();
    expect(logInfo).toHaveBeenCalledWith(`${label} waiting to start: database url unavailable`);

    urlReady = true;
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(logInfo).toHaveBeenCalledWith(`${label} waiting to start: migrations pending`);
    expect(work).not.toHaveBeenCalled();

    await stop();
  });
});
