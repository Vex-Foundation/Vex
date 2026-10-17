/**
 * vex.system.runtimeStatus / runtimeRetry and the runtimeProgress broadcast.
 *
 * Contract: the status is the progress tracker's current state, whole; Retry
 * starts the native runtime again only after a failed start (never while one
 * is in flight, never over a ready runtime, never outside native mode) and
 * answers with the status after the call; every tracker change reaches every
 * window on EV.system.runtimeProgress.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { CH, EV } from "@shared/ipc/channels.js";
import { createTrustedSender, type TestIpcEvent } from "./test-sender.js";

type Handler = (event: TestIpcEvent, raw: unknown) => Promise<unknown>;

const mocks = vi.hoisted(() => ({
  mode: "native" as "native" | "docker",
  startNativeRuntime: vi.fn(),
  send: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const handlers = new Map<string, Handler>();

vi.mock("electron", () => ({
  app: { getPath: () => "/tmp", getVersion: () => "0.0.0", isPackaged: false },
  net: { fetch: vi.fn() },
  ipcMain: {
    handle: (channel: string, fn: Handler) => {
      handlers.set(channel, fn);
    },
    removeHandler: (channel: string) => {
      handlers.delete(channel);
    },
  },
  BrowserWindow: {
    getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: mocks.send } }],
  },
}));
vi.mock("../../logger/index.js", () => ({ log: mocks.log }));
vi.mock("../system/notify-turn-complete.js", () => ({ registerSystemNotifyTurnCompleteHandler: () => () => {} }));
vi.mock("../system/title-bar-overlay.js", () => ({ registerSystemTitleBarOverlayHandler: () => () => {} }));
vi.mock("../system/local-runtime.js", () => ({ registerSystemLocalRuntimeHandlers: () => [] }));
vi.mock("../../runtime/runtime-mode.js", () => ({ getRuntimeMode: () => mocks.mode }));
vi.mock("../../runtime/native/native-runtime.js", () => ({ startNativeRuntime: mocks.startNativeRuntime }));

const { registerSystemHandlers } = await import("../system.js");
const { nativeRuntimeProgress } = await import("../../runtime/native/native-runtime-progress.js");

const sender = createTrustedSender();

async function invoke(channel: string): Promise<unknown> {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`No handler for ${channel}`);
  return handler(sender, { requestId: "11111111-1111-4111-8111-111111111111", payload: {} });
}

let teardowns: Array<() => void> = [];

beforeEach(() => {
  for (const teardown of teardowns) teardown();
  handlers.clear();
  vi.clearAllMocks();
  mocks.mode = "native";
  teardowns = registerSystemHandlers();
});

describe("system.runtimeStatus / runtimeRetry IPC", () => {
  it("answers with the tracker's current status and broadcasts each change", async () => {
    nativeRuntimeProgress.begin(true);
    const status = nativeRuntimeProgress.current();
    expect(await invoke(CH.system.runtimeStatus)).toEqual({ ok: true, data: status });
    expect(mocks.send).toHaveBeenLastCalledWith(EV.system.runtimeProgress, status);

    nativeRuntimeProgress.modelChecking();
    expect(mocks.send).toHaveBeenLastCalledWith(EV.system.runtimeProgress, nativeRuntimeProgress.current());
  });

  it("does not start anything while a start is in flight or once it is ready", async () => {
    nativeRuntimeProgress.begin(false);
    expect(await invoke(CH.system.runtimeRetry)).toEqual({ ok: true, data: nativeRuntimeProgress.current() });
    nativeRuntimeProgress.ready();
    expect(await invoke(CH.system.runtimeRetry)).toEqual({ ok: true, data: nativeRuntimeProgress.current() });
    expect(mocks.startNativeRuntime).not.toHaveBeenCalled();
  });

  it("starts the native runtime again after a failure", async () => {
    nativeRuntimeProgress.begin(false);
    nativeRuntimeProgress.fail("offline", "The embeddings model could not be downloaded: offline");
    mocks.startNativeRuntime.mockImplementation(() => {
      nativeRuntimeProgress.begin(false);
      return new Promise(() => {});
    });
    const answer = await invoke(CH.system.runtimeRetry);
    expect(mocks.startNativeRuntime).toHaveBeenCalledTimes(1);
    expect(answer).toEqual({ ok: true, data: expect.objectContaining({ phase: "postgres" }) });
  });

  it("is a no-op outside the native runtime", async () => {
    nativeRuntimeProgress.begin(false);
    nativeRuntimeProgress.fail("failed", "boom");
    mocks.mode = "docker";
    await invoke(CH.system.runtimeRetry);
    expect(mocks.startNativeRuntime).not.toHaveBeenCalled();
  });
});
