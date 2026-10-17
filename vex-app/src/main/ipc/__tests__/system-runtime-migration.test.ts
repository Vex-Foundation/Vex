/**
 * vex.system.runtimeMigration* and the runtimeMigrationProgress broadcast.
 *
 * Contract: in native mode every channel is the gate's answer, validated on
 * the way out; outside it there is nothing to move and the gate is never
 * reached. A Move that joins a move in flight is sent its latest progress
 * event directly; every progress event reaches every window.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { CH, EV } from "@shared/ipc/channels.js";
import type { RuntimeMigrationProgress } from "@shared/schemas/runtime-migration.js";
import { createTestWebContents, createTrustedSender, type TestIpcEvent } from "./test-sender.js";

type Handler = (event: TestIpcEvent, raw: unknown) => Promise<unknown>;

const mocks = vi.hoisted(() => ({
  mode: "native" as "native" | "docker",
  gate: {
    status: vi.fn(),
    migrate: vi.fn(),
    startFresh: vi.fn(),
    removeOldData: vi.fn(),
    lastProgress: vi.fn(),
  },
  broadcast: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const handlers = new Map<string, Handler>();

vi.mock("electron", () => ({
  app: { isPackaged: false },
  ipcMain: {
    handle: (channel: string, fn: Handler) => {
      handlers.set(channel, fn);
    },
    removeHandler: (channel: string) => {
      handlers.delete(channel);
    },
  },
  BrowserWindow: { getAllWindows: () => [] },
}));
vi.mock("../../logger/index.js", () => ({ log: mocks.log }));
vi.mock("../../lifecycle/broadcast.js", () => ({ broadcastToAllWindows: mocks.broadcast }));
vi.mock("../../runtime/runtime-mode.js", () => ({ getRuntimeMode: () => mocks.mode }));
vi.mock("../../runtime/migration/native-start-gate.js", async () => {
  const { ReplayBus } = await import("../../events/event-bus.js");
  return { nativeStartGate: () => mocks.gate, runtimeMigrationProgressBus: new ReplayBus<RuntimeMigrationProgress>() };
});

const { registerSystemRuntimeMigrationHandlers } = await import("../system/runtime-migration.js");
const { runtimeMigrationProgressBus } = await import("../../runtime/migration/native-start-gate.js");

const sender = createTrustedSender({ sender: createTestWebContents() });

async function invoke(channel: string, payload: unknown = {}): Promise<unknown> {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`No handler for ${channel}`);
  return handler(sender, { requestId: "11111111-1111-4111-8111-111111111111", payload });
}

let teardowns: Array<() => void> = [];

beforeEach(() => {
  for (const teardown of teardowns) teardown();
  handlers.clear();
  vi.clearAllMocks();
  mocks.mode = "native";
  mocks.gate.lastProgress.mockReturnValue(null);
  teardowns = registerSystemRuntimeMigrationHandlers();
});

describe("system.runtimeMigration* IPC", () => {
  it("answers the status with the gate's", async () => {
    mocks.gate.status.mockResolvedValue({ kind: "pending", resumeStep: "dumped", lastFailure: null });
    expect(await invoke(CH.system.runtimeMigrationStatus)).toEqual({
      ok: true,
      data: { kind: "pending", resumeStep: "dumped", lastFailure: null },
    });
  });

  it("moves through the gate and replays the latest event to a caller joining a move in flight", async () => {
    const last: RuntimeMigrationProgress = { seq: 7, phase: "dumping", bytesWritten: 512, estimatedBytes: 4096 };
    mocks.gate.lastProgress.mockReturnValue(last);
    mocks.gate.migrate.mockResolvedValue({ kind: "migrated", oldStackStopped: true, message: "Copied." });
    expect(await invoke(CH.system.runtimeMigrationMove)).toEqual({
      ok: true,
      data: { kind: "migrated", oldStackStopped: true, message: "Copied." },
    });
    expect(sender.sender.send).toHaveBeenCalledWith(EV.system.runtimeMigrationProgress, last);
  });

  it("does not replay anything to a fresh Move", async () => {
    mocks.gate.migrate.mockResolvedValue({
      kind: "failed",
      reason: "disk_full",
      message: "Needs 900 bytes.",
      requiredBytes: 900,
      availableBytes: 100,
    });
    expect(await invoke(CH.system.runtimeMigrationMove)).toMatchObject({ ok: true, data: { reason: "disk_full", requiredBytes: 900 } });
    expect(sender.sender.send).not.toHaveBeenCalled();
  });

  it("starts fresh and removes the old data through the gate", async () => {
    mocks.gate.startFresh.mockResolvedValue({ kind: "started_fresh" });
    expect(await invoke(CH.system.runtimeMigrationStartFresh)).toEqual({ ok: true, data: { kind: "started_fresh" } });
    mocks.gate.removeOldData.mockResolvedValue({ kind: "refused", reason: "not_imported", message: "Only copy." });
    expect(await invoke(CH.system.runtimeMigrationRemoveOldData, { allowWithoutImport: false })).toEqual({
      ok: true,
      data: { kind: "refused", reason: "not_imported", message: "Only copy." },
    });
    expect(mocks.gate.removeOldData).toHaveBeenCalledWith({ allowWithoutImport: false });
  });

  it("refuses a malformed remove request before the gate", async () => {
    const answer = (await invoke(CH.system.runtimeMigrationRemoveOldData, { allowWithoutImport: "yes" })) as { ok: boolean };
    expect(answer.ok).toBe(false);
    expect(mocks.gate.removeOldData).not.toHaveBeenCalled();
  });

  it("refuses an off-contract answer from the gate", async () => {
    mocks.gate.status.mockResolvedValue({ kind: "pending", installId: "leaks", resumeStep: null, lastFailure: null });
    const answer = (await invoke(CH.system.runtimeMigrationStatus)) as { ok: boolean };
    expect(answer.ok).toBe(false);
  });

  it("has nothing to move outside the native runtime and never reaches the gate", async () => {
    mocks.mode = "docker";
    expect(await invoke(CH.system.runtimeMigrationStatus)).toEqual({ ok: true, data: { kind: "not_needed" } });
    expect(await invoke(CH.system.runtimeMigrationMove)).toMatchObject({ ok: true, data: { kind: "failed", reason: "not_pending" } });
    expect(await invoke(CH.system.runtimeMigrationStartFresh)).toMatchObject({ ok: true, data: { kind: "failed", reason: "not_pending" } });
    expect(await invoke(CH.system.runtimeMigrationRemoveOldData, { allowWithoutImport: true })).toMatchObject({
      ok: true,
      data: { kind: "refused", reason: "not_completed" },
    });
    for (const fn of Object.values(mocks.gate)) expect(fn).not.toHaveBeenCalled();
  });

  it("broadcasts every progress event to every window", () => {
    const event: RuntimeMigrationProgress = { seq: 1, phase: "preparing" };
    runtimeMigrationProgressBus.emit(event);
    expect(mocks.broadcast).toHaveBeenCalledWith(EV.system.runtimeMigrationProgress, event);
  });
});
