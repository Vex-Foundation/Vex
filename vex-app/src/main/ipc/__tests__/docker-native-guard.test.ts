/**
 * On the native runtime nothing may touch Docker: every `vex:docker:*`
 * handler refuses before it reaches the CLI, the engine socket or the Model
 * Runner port, and outside native mode they still run.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { CH } from "@shared/ipc/channels.js";

type Handler = (event: unknown, raw: unknown) => Promise<unknown>;

const mocks = vi.hoisted(() => ({
  mode: "native" as "native" | "e2e_door",
  probeDocker: vi.fn(),
  performInstall: vi.fn(),
  performStart: vi.fn(),
  composeUp: vi.fn(),
  composeDown: vi.fn(),
  stopPreviousInstallStacks: vi.fn(),
}));

const handlers = new Map<string, Handler>();

vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, fn: Handler) => {
      handlers.set(channel, fn);
    },
    removeHandler: (channel: string) => {
      handlers.delete(channel);
    },
  },
  app: { isPackaged: true },
}));
vi.mock("../../logger/index.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), verbose: vi.fn(), silly: vi.fn() },
}));
vi.mock("../../lifecycle/broadcast.js", () => ({ broadcastToAllWindows: vi.fn() }));
vi.mock("../../runtime/runtime-mode.js", () => ({ getRuntimeMode: () => mocks.mode }));
vi.mock("../../docker/probe.js", () => ({ probeDocker: mocks.probeDocker }));
vi.mock("../../docker/install.js", () => ({ performInstall: mocks.performInstall }));
vi.mock("../../docker/start.js", () => ({ performStart: mocks.performStart }));
vi.mock("../../docker/progress-bus.js", () => ({
  composeLogBus: { emit: vi.fn(), subscribe: () => () => {} },
  dockerProgressBus: { emit: vi.fn(), subscribe: () => () => {} },
}));
vi.mock("../../runtime/docker/docker-provider.js", () => ({
  createDockerProvider: () => ({
    id: "docker",
    start: mocks.composeUp,
    stop: mocks.composeDown,
    stopPreviousInstallStacks: mocks.stopPreviousInstallStacks,
  }),
}));

const { registerDockerHandlers } = await import("../docker.js");
registerDockerHandlers();

function trustedSender(): unknown {
  const frame: { url: string; parent: null; top: unknown } = { url: "app://vex/index.html", parent: null, top: null };
  frame.top = frame;
  return { senderFrame: frame };
}

async function invoke(channel: string, payload: unknown = {}): Promise<unknown> {
  const handler = handlers.get(channel);
  if (handler === undefined) throw new Error(`No handler for ${channel}`);
  return handler(trustedSender(), { requestId: "11111111-1111-4111-8111-111111111111", payload });
}

const CALLS: ReadonlyArray<readonly [string, unknown]> = [
  [CH.docker.detect, {}],
  [CH.docker.install, { method: "desktop_download" }],
  [CH.docker.start, {}],
  [CH.docker.composeUp, {}],
  [CH.docker.stopPreviousInstallStacks, {}],
  [CH.docker.composeDown, {}],
];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.mode = "native";
});

describe("vex:docker:* on the native runtime", () => {
  it.each(CALLS)("%s is refused without touching Docker", async (channel, payload) => {
    expect(await invoke(channel, payload)).toEqual({
      ok: false,
      error: expect.objectContaining({
        code: "services.docker_unavailable",
        domain: "docker",
        correlationId: "11111111-1111-4111-8111-111111111111",
        retryable: false,
      }),
    });
    expect(mocks.probeDocker).not.toHaveBeenCalled();
    expect(mocks.performInstall).not.toHaveBeenCalled();
    expect(mocks.performStart).not.toHaveBeenCalled();
    expect(mocks.composeUp).not.toHaveBeenCalled();
    expect(mocks.composeDown).not.toHaveBeenCalled();
    expect(mocks.stopPreviousInstallStacks).not.toHaveBeenCalled();
  });

  it("detection still runs outside the native runtime", async () => {
    mocks.mode = "e2e_door";
    mocks.probeDocker.mockRejectedValue(new Error("probe ran"));
    await invoke(CH.docker.detect);
    expect(mocks.probeDocker).toHaveBeenCalledTimes(1);
  });
});
