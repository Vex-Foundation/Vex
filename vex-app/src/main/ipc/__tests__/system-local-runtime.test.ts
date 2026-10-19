/**
 * vex.system.runtimeInfo / runtimeRestart / runtimeReset at the IPC boundary.
 *
 * Contract: runtimeInfo answers only in native mode and carries no path;
 * restart and reset answer with what the maintenance module decided (its
 * guards have their own suite); reset requires the exact typed phrase, checked
 * by the input schema before anything runs; only a completed reset relaunches
 * the app, after the answer.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { CH } from "@shared/ipc/channels.js";
import type { LocalRuntimeInfo, RuntimeResetResult, RuntimeRestartResult } from "@shared/schemas/system.js";
import { createTrustedSender, type TestIpcEvent } from "./test-sender.js";

type Handler = (event: TestIpcEvent, raw: unknown) => Promise<unknown>;

const mocks = vi.hoisted(() => ({
  mode: "native" as "native" | "e2e_door",
  info: vi.fn<() => Promise<LocalRuntimeInfo>>(),
  restart: vi.fn<() => Promise<RuntimeRestartResult>>(),
  reset: vi.fn<() => Promise<RuntimeResetResult>>(),
  relaunch: vi.fn(),
  quit: vi.fn(),
}));

const handlers = new Map<string, Handler>();

vi.mock("electron", () => ({
  app: { relaunch: mocks.relaunch, quit: mocks.quit, getPath: () => "/tmp", isPackaged: false },
  ipcMain: {
    handle: (channel: string, fn: Handler) => {
      handlers.set(channel, fn);
    },
    removeHandler: (channel: string) => {
      handlers.delete(channel);
    },
  },
}));
vi.mock("../../logger/index.js", () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock("../../runtime/runtime-mode.js", () => ({ getRuntimeMode: () => mocks.mode }));
vi.mock("../../runtime/native/local-runtime-actions.js", () => ({
  readLocalRuntimeInfo: mocks.info,
  restartLocalRuntime: mocks.restart,
  resetLocalData: mocks.reset,
}));

const { registerSystemLocalRuntimeHandlers } = await import("../system/local-runtime.js");

const sender = createTrustedSender();
const REQUEST_ID = "11111111-1111-4111-8111-111111111111";

async function invoke(channel: string, payload: unknown = {}): Promise<unknown> {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`No handler for ${channel}`);
  return handler(sender, { requestId: REQUEST_ID, payload });
}

const INFO: LocalRuntimeInfo = {
  release: "native-runtime-2026.10.17-1",
  versions: { postgres: "18.6", pgvector: "0.8.7", llamaCpp: "b9115" },
  sizes: {
    database: { bytes: 52_000_000, files: 1_200, complete: true },
    model: { bytes: 333_590_944, files: 2, complete: true },
  },
  previousReleaseData: { kind: "none" },
};

const flushImmediates = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

let teardowns: Array<() => void> = [];

beforeEach(() => {
  for (const teardown of teardowns) teardown();
  handlers.clear();
  vi.clearAllMocks();
  mocks.mode = "native";
  teardowns = registerSystemLocalRuntimeHandlers();
});

describe("system.runtimeInfo", () => {
  it("answers with the release, versions and sizes in native mode", async () => {
    mocks.info.mockResolvedValue(INFO);
    expect(await invoke(CH.system.runtimeInfo)).toEqual({ ok: true, data: INFO });
  });

  it("is denied outside the native runtime, without measuring anything", async () => {
    mocks.mode = "e2e_door";
    expect(await invoke(CH.system.runtimeInfo)).toMatchObject({
      ok: false,
      error: { code: "permissions.denied", domain: "system" },
    });
    expect(mocks.info).not.toHaveBeenCalled();
  });

  it("drops an answer that would carry a path", async () => {
    mocks.info.mockResolvedValue({ ...INFO, dataDir: "/Users/someone/.vex/runtime/pg18" } as LocalRuntimeInfo);
    expect(await invoke(CH.system.runtimeInfo)).toMatchObject({ ok: false });
  });
});

describe("system.runtimeRestart", () => {
  it("answers with the restart's outcome and never relaunches", async () => {
    mocks.restart.mockResolvedValue({ kind: "restarted", status: { seq: 12, phase: "ready" } });
    expect(await invoke(CH.system.runtimeRestart)).toEqual({
      ok: true,
      data: { kind: "restarted", status: { seq: 12, phase: "ready" } },
    });
    mocks.restart.mockResolvedValue({ kind: "refused", reason: "busy", message: "The local runtime is busy." });
    expect(await invoke(CH.system.runtimeRestart)).toMatchObject({ ok: true, data: { kind: "refused", reason: "busy" } });
    await flushImmediates();
    expect(mocks.relaunch).not.toHaveBeenCalled();
  });
});

describe("system.runtimeReset", () => {
  it.each([
    ["no phrase", {}],
    ["the wrong phrase", { confirmation: "reset" }],
    ["an extra key", { confirmation: "RESET", alsoDeleteWallets: true }],
  ])("rejects %s before anything runs", async (_label, payload) => {
    expect(await invoke(CH.system.runtimeReset, payload)).toMatchObject({
      ok: false,
      error: { code: "validation.invalid_input" },
    });
    expect(mocks.reset).not.toHaveBeenCalled();
  });

  it("relaunches the app after a completed reset, once the answer is out", async () => {
    mocks.reset.mockResolvedValue({ kind: "reset", deletedBytes: 52_000_000, relaunching: true });
    const answer = await invoke(CH.system.runtimeReset, { confirmation: "RESET" });
    expect(answer).toEqual({ ok: true, data: { kind: "reset", deletedBytes: 52_000_000, relaunching: true } });
    expect(mocks.relaunch).not.toHaveBeenCalled();
    await flushImmediates();
    expect(mocks.relaunch).toHaveBeenCalledTimes(1);
    expect(mocks.quit).toHaveBeenCalledTimes(1);
  });

  it.each<[string, RuntimeResetResult]>([
    ["a refusal", { kind: "refused", reason: "still_running", message: "A database process still holds the local data." }],
    ["a failure", { kind: "failed", message: "The local data could not be deleted: EBUSY" }],
  ])("does not relaunch after %s", async (_label, outcome) => {
    mocks.reset.mockResolvedValue(outcome);
    expect(await invoke(CH.system.runtimeReset, { confirmation: "RESET" })).toEqual({ ok: true, data: outcome });
    await flushImmediates();
    expect(mocks.relaunch).not.toHaveBeenCalled();
    expect(mocks.quit).not.toHaveBeenCalled();
  });
});
