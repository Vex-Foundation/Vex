/**
 * The boot gate in front of the native runtime's start (the engine's
 * contract in `docker-to-native.ts`): detect first, start only on
 * `not_needed`, never while a move is pending or in flight, and start once
 * a move or a start-fresh has put the data in the native cluster. The
 * engine is a stand-in; `docker-to-native.real.test.ts` runs the real one.
 */

import { describe, expect, it, vi } from "vitest";
import type { RuntimeMigrationProgress } from "@shared/schemas/runtime-migration.js";

vi.mock("../../logger/index.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../native/native-runtime.js", () => ({ startNativeRuntime: vi.fn() }));
vi.mock("../migration/docker-to-native.js", () => ({ productionMigration: vi.fn() }));

const { createNativeStartGate } = await import("../migration/native-start-gate.js");

type Gate = ReturnType<typeof createNativeStartGate>;
type Deps = Parameters<typeof createNativeStartGate>[0];
type Engine = Deps["migration"];
type Status = Awaited<ReturnType<Engine["detect"]>>;
type Migrate = Awaited<ReturnType<Engine["migrate"]>>;
type MigrateOptions = Parameters<Engine["migrate"]>[0];

const PENDING: Status = { kind: "pending", installId: "install-1", resumeStep: null, lastFailure: null };
const MIGRATED: Migrate = { kind: "migrated", report: null, oldStackStopped: true, message: "Your data was copied." };
const RUNNING = { kind: "running", message: "ok" } as const;

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function setup(initial: Status): {
  gate: Gate;
  engine: { [K in keyof Engine]: ReturnType<typeof vi.fn> };
  startNative: ReturnType<typeof vi.fn>;
  published: RuntimeMigrationProgress[];
  setStatus: (status: Status) => void;
} {
  let status = initial;
  const engine = {
    detect: vi.fn(async () => status),
    migrate: vi.fn(async (): Promise<Migrate> => MIGRATED),
    startFresh: vi.fn(async () => ({ kind: "started_fresh" as const })),
    removeOldData: vi.fn(async () => ({ kind: "removed" as const, message: "Removed." })),
  };
  const startNative = vi.fn(async () => RUNNING);
  const published: RuntimeMigrationProgress[] = [];
  const gate = createNativeStartGate({
    migration: engine,
    startNative,
    publishProgress: (p) => published.push(p),
  });
  return { gate, engine, startNative, published, setStatus: (next) => (status = next) };
}

describe("the native start gate", () => {
  it("never starts the native runtime while the move is pending", async () => {
    const { gate, startNative } = setup(PENDING);
    await gate.boot();
    expect(startNative).not.toHaveBeenCalled();
    expect(await gate.startNative()).toMatchObject({ kind: "migration_pending" });
    expect(startNative).not.toHaveBeenCalled();
    expect(await gate.status()).toEqual({ kind: "pending", resumeStep: null, lastFailure: null });
  });

  it("starts it at boot when nothing is pending, and lets the callers join it", async () => {
    const { gate, startNative } = setup({ kind: "not_needed", reason: "native_install" });
    await gate.boot();
    expect(startNative).toHaveBeenCalledTimes(1);
    expect(await gate.startNative()).toEqual(RUNNING);
    expect(await gate.status()).toEqual({ kind: "not_needed" });
  });

  it("keeps the gate shut on an unreadable state, and on a detection that throws", async () => {
    const unreadable = setup({ kind: "state_unreadable", message: "runtime-state.json does not parse" });
    await unreadable.gate.boot();
    expect(await unreadable.gate.startNative()).toMatchObject({ kind: "migration_pending" });
    expect(await unreadable.gate.status()).toEqual({ kind: "state_unreadable", message: "runtime-state.json does not parse" });

    const throws = setup(PENDING);
    throws.engine.detect.mockRejectedValue(new Error("EIO"));
    await throws.gate.boot();
    expect(await throws.gate.status()).toMatchObject({ kind: "state_unreadable", message: expect.stringContaining("EIO") });
    expect(unreadable.startNative).not.toHaveBeenCalled();
    expect(throws.startNative).not.toHaveBeenCalled();
  });

  it("names the old stack's engine being down as the source being offline, never by its tool", async () => {
    const { gate } = setup({
      kind: "pending_docker_unavailable",
      installId: "install-1",
      detail: "Cannot connect to the daemon",
      resumeStep: "started",
      lastFailure: { kind: "docker_unavailable", message: "not running", at: "2026-10-17T10:00:00.000Z" },
    });
    expect(await gate.status()).toEqual({
      kind: "pending_source_offline",
      detail: "Cannot connect to the daemon",
      resumeStep: "started",
      lastFailure: { reason: "source_offline", message: "not running", at: "2026-10-17T10:00:00.000Z" },
    });
  });

  it("starts the native runtime once the move has migrated the data", async () => {
    const { gate, engine, startNative, setStatus } = setup(PENDING);
    await gate.boot();
    engine.migrate.mockImplementation(async (options: MigrateOptions) => {
      options?.onProgress?.({ phase: "preparing" });
      options?.onProgress?.({ phase: "dumping", bytesWritten: 10, estimatedBytes: 100 });
      setStatus({ kind: "not_needed", reason: "migrated" });
      return MIGRATED;
    });
    expect(await gate.migrate()).toEqual({ kind: "migrated", oldStackStopped: true, message: "Your data was copied." });
    expect(startNative).toHaveBeenCalledTimes(1);
    expect(await gate.status()).toEqual({ kind: "not_needed" });
    expect(await gate.startNative()).toEqual(RUNNING);
    // A second Move on an open gate never reaches the engine.
    expect(await gate.migrate()).toEqual({ kind: "already_completed", outcome: "migrated" });
    expect(engine.migrate).toHaveBeenCalledTimes(1);
  });

  it("starts it after a resumed move that had already completed, and after start fresh", async () => {
    const resumed = setup(PENDING);
    resumed.engine.migrate.mockResolvedValue({ kind: "already_completed", outcome: "migrated" });
    expect(await resumed.gate.migrate()).toEqual({ kind: "already_completed", outcome: "migrated" });
    expect(resumed.startNative).toHaveBeenCalledTimes(1);

    const fresh = setup(PENDING);
    expect(await fresh.gate.startFresh()).toEqual({ kind: "started_fresh" });
    expect(fresh.startNative).toHaveBeenCalledTimes(1);
    expect(await fresh.gate.status()).toEqual({ kind: "not_needed" });
    expect(await fresh.gate.startFresh()).toEqual({ kind: "started_fresh" });
    expect(fresh.engine.startFresh).toHaveBeenCalledTimes(1);
  });

  it("owns the cluster while a move runs: nothing starts, a second Move joins, start fresh is busy", async () => {
    const { gate, engine, startNative, published } = setup(PENDING);
    await gate.boot();
    const run = deferred<Migrate>();
    engine.migrate.mockImplementation(async (options: MigrateOptions) => {
      options?.onProgress?.({ phase: "preparing" });
      options?.onProgress?.({ phase: "restoring" });
      return run.promise;
    });
    const first = gate.migrate();
    const second = gate.migrate();
    await vi.waitFor(() => expect(published).toHaveLength(2));

    expect(await gate.status()).toEqual({ kind: "in_progress", op: "migrate", progress: { seq: 2, phase: "restoring" } });
    expect(gate.lastProgress()).toEqual({ seq: 2, phase: "restoring" });
    expect(await gate.startNative()).toMatchObject({ kind: "migration_pending" });
    expect(await gate.startFresh()).toMatchObject({ kind: "failed", reason: "busy" });
    expect(await gate.removeOldData({ allowWithoutImport: false })).toMatchObject({ kind: "refused", reason: "busy" });
    expect(published.map((p) => p.seq)).toEqual([1, 2]);

    run.resolve(MIGRATED);
    expect(await first).toEqual(await second);
    expect(engine.migrate).toHaveBeenCalledTimes(1);
    expect(startNative).toHaveBeenCalledTimes(1);
    expect(gate.lastProgress()).toBeNull();
  });

  it("stays shut after a failed move and maps the failure", async () => {
    const { gate, engine, startNative } = setup(PENDING);
    engine.migrate.mockResolvedValue({
      kind: "failed",
      reason: "disk_full",
      message: "Copying the data needs 900 bytes free; 100 are.",
      report: null,
      requiredBytes: 900,
      availableBytes: 100,
    });
    expect(await gate.migrate()).toEqual({
      kind: "failed",
      reason: "disk_full",
      message: "Copying the data needs 900 bytes free; 100 are.",
      requiredBytes: 900,
      availableBytes: 100,
    });
    engine.migrate.mockResolvedValue({
      kind: "failed",
      reason: "docker_unavailable",
      message: "not running",
      report: null,
      requiredBytes: null,
      availableBytes: null,
    });
    expect(await gate.migrate()).toMatchObject({ kind: "failed", reason: "source_offline" });
    expect(startNative).not.toHaveBeenCalled();
    expect(await gate.startNative()).toMatchObject({ kind: "migration_pending" });
  });

  it("re-detects after the engine says there is nothing to move, and opens on its answer", async () => {
    const { gate, engine, startNative, setStatus } = setup(PENDING);
    engine.migrate.mockImplementation(async () => {
      setStatus({ kind: "not_needed", reason: "no_docker_volume" });
      return { kind: "failed", reason: "not_pending", message: "No volume.", report: null, requiredBytes: null, availableBytes: null };
    });
    expect(await gate.migrate()).toMatchObject({ kind: "failed", reason: "not_pending" });
    expect(startNative).toHaveBeenCalledTimes(1);
  });

  it("never runs a move or a start fresh on an install that needs neither", async () => {
    const { gate, engine } = setup({ kind: "not_needed", reason: "no_docker_install" });
    await gate.boot();
    expect(await gate.migrate()).toMatchObject({ kind: "failed", reason: "not_pending" });
    expect(await gate.startFresh()).toMatchObject({ kind: "failed", reason: "not_pending" });
    expect(engine.migrate).not.toHaveBeenCalled();
    expect(engine.startFresh).not.toHaveBeenCalled();
  });

  it("quit aborts the move in flight and waits for it; the gate stays shut", async () => {
    const { gate, engine, startNative } = setup(PENDING);
    let signal: AbortSignal | undefined;
    engine.migrate.mockImplementation(
      (options: MigrateOptions) =>
        new Promise<Migrate>((resolve) => {
          signal = options?.signal;
          options?.signal?.addEventListener("abort", () => resolve({ kind: "cancelled", resumeStep: "dumped" }));
        }),
    );
    const running = gate.migrate();
    await vi.waitFor(() => expect(signal).toBeDefined());
    await gate.shutdown();
    expect(signal?.aborted).toBe(true);
    expect(await running).toEqual({ kind: "cancelled", resumeStep: "dumped" });
    expect(startNative).not.toHaveBeenCalled();
  });

  it("maps removing the old data, with the engine's refusals", async () => {
    const { gate, engine } = setup({ kind: "not_needed", reason: "migrated" });
    expect(await gate.removeOldData({ allowWithoutImport: true })).toEqual({ kind: "removed", message: "Removed." });
    expect(engine.removeOldData).toHaveBeenCalledWith(expect.objectContaining({ allowWithoutImport: true }));
    engine.removeOldData.mockResolvedValue({ kind: "failed", reason: "docker_unavailable", message: "down" });
    expect(await gate.removeOldData({ allowWithoutImport: false })).toEqual({ kind: "failed", reason: "source_offline", message: "down" });
  });

  it("says it is open (for Settings' restart and reset) only once nothing pending or running owns the cluster", async () => {
    const { gate, engine } = setup(PENDING);
    expect(gate.isOpen()).toBe(false);
    await gate.boot();
    expect(gate.isOpen()).toBe(false);
    const run = deferred<Migrate>();
    engine.migrate.mockImplementation(async () => run.promise);
    const moving = gate.migrate();
    expect(gate.isOpen()).toBe(false);
    run.resolve(MIGRATED);
    await moving;
    expect(gate.isOpen()).toBe(true);

    const fresh = setup({ kind: "not_needed", reason: "native_install" });
    await fresh.gate.boot();
    expect(fresh.gate.isOpen()).toBe(true);
  });
});
