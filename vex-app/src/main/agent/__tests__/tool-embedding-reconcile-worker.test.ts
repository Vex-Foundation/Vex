/**
 * tool-embedding reconcile worker tests (T0.5).
 *
 * Deps are injected, so this exercises pure lifecycle logic without a real DB,
 * embeddings sidecar, or engine. Mirrors sync-worker.test.ts's mocking of the
 * heavy transitive imports (logger, DB probe, db-url helper).
 *
 * Pins:
 *   - the pass does NOT run while the DB url + tool_embeddings schema are not
 *     ready, and startup is never blocked (setup returns synchronously);
 *   - DB unavailable first then ready ⇒ reconcile runs EXACTLY ONCE, then
 *     dormant (Codex-required);
 *   - a completed pass with errors > 0 retries then CAPS at 5 passes per boot;
 *   - a thrown reconcile only warns (never blocks, never rejects out);
 *   - `stop()` is idempotent and prevents any further reconcile.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../logger/index.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../../database/tool-embeddings-db.js", () => ({
  probeToolEmbeddingsReady: vi.fn(),
}));
vi.mock("../../database/engine-db-readiness.js", () => ({
  ensureEngineDbUrl: vi.fn(),
}));
// Migrations are the bootstrap gate every worker now consults; these tests are
// about the LIFECYCLE past it. `migrations-gate.test.ts` owns the gate itself.
vi.mock("../../database/migrations-applied.js", () => ({
  migrationsApplied: () => true,
}));

const { setupToolEmbeddingReconcileWorker } = await import(
  "../tool-embedding-reconcile-worker.js"
);
const { log } = await import("../../logger/index.js");

interface Report {
  embedded: number;
  skipped: number;
  errors: number;
  deleted: number;
  durationMs: number;
  formatterVersion: string;
  embeddingModel: string;
  embeddingDim: number;
}

function report(errors: number): Report {
  return {
    embedded: 0,
    skipped: 0,
    errors,
    deleted: 0,
    durationMs: 1,
    formatterVersion: "v1-test",
    embeddingModel: "actual-model",
    embeddingDim: 768,
  };
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Poll until `pred` holds (robust lower bound under heavy parallel load where
 * fixed sleeps flake). Throws on timeout so a genuinely stuck worker still
 * fails the test.
 */
async function waitFor(pred: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor: condition not met in time");
    await wait(5);
  }
}

// Fast, near-fixed cadence so multi-attempt scenarios finish well under the
// test timeout while staying deterministic.
const FAST = { intervalMs: 5, maxBackoffMs: 5 } as const;

afterEach(() => {
  vi.clearAllMocks();
});

describe("setupToolEmbeddingReconcileWorker", () => {
  it("returns a stop function synchronously (never blocks startup)", () => {
    const reconcile = vi.fn(async () => report(0));
    const stop = setupToolEmbeddingReconcileWorker({
      ensureDbUrl: vi.fn(async () => ({ ok: false })),
      probeReady: vi.fn(async () => true),
      reconcile,
      ...FAST,
    });
    expect(typeof stop).toBe("function");
    void stop();
  });

  it("does not reconcile while the DB url is unavailable", async () => {
    const reconcile = vi.fn(async () => report(0));
    const ensureDbUrl = vi.fn(async () => ({ ok: false }));
    const stop = setupToolEmbeddingReconcileWorker({
      ensureDbUrl,
      probeReady: vi.fn(async () => true),
      reconcile,
      ...FAST,
    });
    await waitFor(() => ensureDbUrl.mock.calls.length >= 1); // a tick ran
    expect(reconcile).not.toHaveBeenCalled();
    await stop();
  });

  it("does not reconcile while the tool_embeddings schema is not ready", async () => {
    const reconcile = vi.fn(async () => report(0));
    const probeReady = vi.fn(async () => false);
    const stop = setupToolEmbeddingReconcileWorker({
      ensureDbUrl: vi.fn(async () => ({ ok: true })),
      probeReady,
      reconcile,
      ...FAST,
    });
    await waitFor(() => probeReady.mock.calls.length >= 1);
    expect(reconcile).not.toHaveBeenCalled();
    await stop();
  });

  it("DB unavailable first then ready ⇒ reconcile runs exactly once then dormant", async () => {
    const reconcile = vi.fn(async () => report(0));
    const ensureDbUrl = vi
      .fn<[string], Promise<{ ok: boolean }>>()
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValue({ ok: true });
    const stop = setupToolEmbeddingReconcileWorker({
      ensureDbUrl,
      probeReady: vi.fn(async () => true),
      reconcile,
      ...FAST,
    });

    await waitFor(() => reconcile.mock.calls.length >= 1);
    // Dormant after a clean pass — no further reconciles (no pending timer).
    await wait(60);
    expect(reconcile).toHaveBeenCalledTimes(1);
    await stop();
  });

  it("a clean pass (errors === 0) goes dormant immediately", async () => {
    const reconcile = vi.fn(async () => report(0));
    const stop = setupToolEmbeddingReconcileWorker({
      ensureDbUrl: vi.fn(async () => ({ ok: true })),
      probeReady: vi.fn(async () => true),
      reconcile,
      ...FAST,
    });
    await waitFor(() => reconcile.mock.calls.length >= 1);
    await wait(60);
    expect(reconcile).toHaveBeenCalledTimes(1);
    await stop();
  });

  it("errors > 0 retries then caps at 5 passes per boot", async () => {
    const reconcile = vi.fn(async () => report(1));
    const stop = setupToolEmbeddingReconcileWorker({
      ensureDbUrl: vi.fn(async () => ({ ok: true })),
      probeReady: vi.fn(async () => true),
      reconcile,
      ...FAST,
    });

    await waitFor(() => reconcile.mock.calls.length >= 5);
    // Cap reached — no more passes (dormant clears the timer).
    await wait(60);
    expect(reconcile).toHaveBeenCalledTimes(5);
    // Gave up with a warning.
    expect(log.warn).toHaveBeenCalled();
    await stop();
  });

  it("a thrown reconcile only warns and never rejects out (retries under the cap)", async () => {
    const reconcile = vi.fn(async () => {
      throw new Error("sidecar down");
    });
    const stop = setupToolEmbeddingReconcileWorker({
      ensureDbUrl: vi.fn(async () => ({ ok: true })),
      probeReady: vi.fn(async () => true),
      reconcile,
      ...FAST,
    });

    // Thrown infra errors are retried under the same 5-pass cap.
    await waitFor(() => reconcile.mock.calls.length >= 5);
    await wait(60);
    expect(reconcile).toHaveBeenCalledTimes(5);
    expect(log.warn).toHaveBeenCalledWith(
      "[tool-embedding-reconcile] reconcile pass failed",
      expect.any(Error),
    );
    await stop();
  });

  it("stop() is idempotent", async () => {
    const reconcile = vi.fn(async () => report(0));
    const stop = setupToolEmbeddingReconcileWorker({
      ensureDbUrl: vi.fn(async () => ({ ok: true })),
      probeReady: vi.fn(async () => true),
      reconcile,
      ...FAST,
    });
    await waitFor(() => reconcile.mock.calls.length >= 1);
    await stop();
    await stop();
    expect(reconcile).toHaveBeenCalledTimes(1);
  });

  it("stop() during gate-wait resolves and prevents any reconcile", async () => {
    const reconcile = vi.fn(async () => report(0));
    const stop = setupToolEmbeddingReconcileWorker({
      ensureDbUrl: vi.fn(async () => ({ ok: false })),
      probeReady: vi.fn(async () => true),
      reconcile,
      ...FAST,
    });
    await stop();
    await stop();
    await wait(40);
    expect(reconcile).not.toHaveBeenCalled();
  });
});
