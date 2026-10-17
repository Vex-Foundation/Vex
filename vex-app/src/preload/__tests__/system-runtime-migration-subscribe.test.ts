/**
 * THE PRELOAD BOUNDARY for `EV.system.runtimeMigrationProgress`, and the
 * remove-old-data input.
 *
 * Mirrors `system-runtime-progress-subscribe.test.ts`: an off-contract event
 * from main is dropped here, before it becomes the migration screen's state,
 * and a malformed remove request never reaches main.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { RuntimeMigrationProgress } from "../../shared/schemas/runtime-migration.js";

const listeners = new Map<string, Array<(event: unknown, raw: unknown) => void>>();
const invoke = vi.fn();

vi.mock("electron", () => ({
  ipcRenderer: {
    on: (channel: string, handler: (event: unknown, raw: unknown) => void) => {
      listeners.set(channel, [...(listeners.get(channel) ?? []), handler]);
    },
    removeListener: (channel: string, handler: (event: unknown, raw: unknown) => void) => {
      listeners.set(channel, (listeners.get(channel) ?? []).filter((item) => item !== handler));
    },
    invoke: (...args: unknown[]) => invoke(...args),
  },
}));

const { CH, EV } = await import("../../shared/ipc/channels.js");
const { system } = await import("../shell/system.js");

const DUMPING: RuntimeMigrationProgress = { seq: 3, phase: "dumping", bytesWritten: 1_000, estimatedBytes: 50_000 };

function emit(raw: unknown): void {
  for (const handler of listeners.get(EV.system.runtimeMigrationProgress) ?? []) handler({}, raw);
}

beforeEach(() => {
  listeners.clear();
  invoke.mockReset();
});

describe("vex.system.onRuntimeMigrationProgress", () => {
  it.each([
    ["a dump", DUMPING],
    ["a step", { seq: 4, phase: "verifying" }],
  ])("delivers %s", (_label, payload) => {
    const cb = vi.fn();
    system.onRuntimeMigrationProgress(cb);
    emit(payload);
    expect(cb).toHaveBeenCalledWith(payload);
  });

  it.each([
    ["an extra key", { ...DUMPING, dumpPath: "/Users/someone/.vex/runtime/migration/vex.dump" }],
    ["an unknown phase", { seq: 1, phase: "teleporting" }],
    ["negative bytes", { ...DUMPING, bytesWritten: -1 }],
    ["a dump without its estimate", { seq: 3, phase: "dumping", bytesWritten: 1 }],
    ["a missing seq", { phase: "restoring" }],
  ])("DROPS %s", (_label, payload) => {
    const cb = vi.fn();
    system.onRuntimeMigrationProgress(cb);
    emit(payload);
    expect(cb).not.toHaveBeenCalled();
  });

  it("returns an idempotent unsubscribe that removes the listener", () => {
    const cb = vi.fn();
    const off = system.onRuntimeMigrationProgress(cb);
    off();
    off();
    emit(DUMPING);
    expect(cb).not.toHaveBeenCalled();
    expect(listeners.get(EV.system.runtimeMigrationProgress) ?? []).toHaveLength(0);
  });
});

describe("vex.system.runtimeMigrationRemoveOldData", () => {
  it("sends a valid request to main", async () => {
    invoke.mockResolvedValue({ ok: true, data: { kind: "removed", message: "Removed." } });
    await system.runtimeMigrationRemoveOldData({ allowWithoutImport: false });
    expect(invoke).toHaveBeenCalledWith(
      CH.system.runtimeMigrationRemoveOldData,
      expect.objectContaining({ payload: { allowWithoutImport: false } }),
    );
  });

  it("rejects a malformed request in preload", async () => {
    const answer = await system.runtimeMigrationRemoveOldData({ allowWithoutImport: "yes" } as never);
    expect(answer).toMatchObject({ ok: false, error: { code: "validation.invalid_input" } });
    expect(invoke).not.toHaveBeenCalled();
  });
});
