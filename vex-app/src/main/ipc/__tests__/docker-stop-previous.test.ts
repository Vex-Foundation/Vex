import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Handler = (
  event: { senderFrame: { url: string; parent: null; top: unknown } },
  raw: unknown,
) => unknown;

const handlers = new Map<string, Handler>();
const cleanupTasks = new Set<() => void | Promise<void>>();

const mocks = vi.hoisted(() => ({
  composeUp: vi.fn(),
  stopPrevious: vi.fn(),
}));

vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, fn: Handler) => handlers.set(channel, fn),
    removeHandler: (channel: string) => handlers.delete(channel),
  },
  app: { isPackaged: true },
}));
vi.mock("../../logger/index.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../../lifecycle/cleanup-registry.js", () => ({
  globalCleanup: {
    add: (task: () => void | Promise<void>) => {
      cleanupTasks.add(task);
      return async () => cleanupTasks.delete(task);
    },
  },
}));
vi.mock("../../lifecycle/broadcast.js", () => ({
  broadcastToAllWindows: vi.fn(),
}));
vi.mock("../../database/connection-state.js", () => ({
  LOOPBACK_DB_HOST: "127.0.0.1",
  setDbConnection: vi.fn(),
}));
vi.mock("../../compose/deps-factory.js", () => ({
  buildRenderDeps: () => ({ userDataDir: "/tmp" }),
}));
vi.mock("../../docker/probe.js", () => ({ probeDocker: vi.fn() }));
vi.mock("../../docker/install.js", () => ({ performInstall: vi.fn() }));
vi.mock("../../docker/start.js", () => ({ performStart: vi.fn() }));
vi.mock("../../docker/progress-bus.js", () => ({
  composeLogBus: { emit: vi.fn(), subscribe: () => () => {} },
  dockerProgressBus: { emit: vi.fn(), subscribe: () => () => {} },
}));
vi.mock("../../compose/lifecycle.js", () => ({
  composeUp: mocks.composeUp,
  composeDown: vi.fn(),
}));
vi.mock("../../compose/orphan-stacks.js", () => ({
  stopStacksHoldingPorts: mocks.stopPrevious,
}));

function trustedSender(): {
  senderFrame: { url: string; parent: null; top: unknown };
} {
  const frame: { url: string; parent: null; top: unknown } = {
    url: "app://vex/index.html",
    parent: null,
    top: null,
  };
  frame.top = frame;
  return { senderFrame: frame };
}

async function loadHandlers(): Promise<void> {
  vi.resetModules();
  const { __resetCancelRegistryForTests } = await import("../register-handler.js");
  __resetCancelRegistryForTests();
  const { registerDockerHandlers } = await import("../docker.js");
  registerDockerHandlers();
}

const REQUEST_ID = "11111111-2222-4333-8444-555555555555";

function invoke(channel: string, payload: unknown, requestId = REQUEST_ID) {
  const handler = handlers.get(channel);
  if (handler === undefined) throw new Error(`${channel} was not registered`);
  return handler(trustedSender(), { requestId, payload });
}

beforeEach(() => {
  handlers.clear();
  cleanupTasks.clear();
  vi.clearAllMocks();
});

afterEach(() => {
  handlers.clear();
  cleanupTasks.clear();
});

describe("docker:stopPreviousInstallStacks IPC", () => {
  it("rejects non-empty input at the strict schema boundary", async () => {
    await loadHandlers();

    const result = await invoke(
      "vex:docker:stopPreviousInstallStacks",
      { containerId: "attacker-controlled" },
    );

    expect(result).toMatchObject({
      ok: false,
      error: { code: "validation.invalid_input" },
    });
    expect(mocks.stopPrevious).not.toHaveBeenCalled();
  });

  it("returns a strict sanitized result with no identifiers", async () => {
    const internalId = "a".repeat(64);
    let guardedByCriticalOp = false;
    mocks.composeUp.mockResolvedValue({
      kind: "port_collision",
      composeOutPath: "/tmp/compose/docker-compose.yml",
      installId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      message: "Previous Vex services hold the port.",
      previousInstallHoldingPorts: true,
      conflictPorts: [27432],
      pgPort: 27432,
      embedPort: 27134,
      pgPasswordPath: "/tmp/secrets/pg_password",
      embeddingsReadiness: null,
    });
    mocks.stopPrevious.mockImplementation(async () => {
      const { activeCriticalOps } = await import(
        "../../updates/critical-ops.js"
      );
      guardedByCriticalOp = activeCriticalOps().includes("docker_lifecycle");
      return {
        ok: true,
        stoppedCount: 1,
        message: "Stopped previous Vex services.",
        internalId,
      };
    });
    await loadHandlers();

    const composeResult = await invoke("vex:docker:composeUp", {});
    expect(composeResult).toMatchObject({ ok: true });
    const result = await invoke(
      "vex:docker:stopPreviousInstallStacks",
      {},
      "22222222-3333-4444-8555-666666666666",
    );

    expect(result).toEqual({
      ok: true,
      data: {
        stoppedCount: 1,
        message: "Stopped previous Vex services.",
      },
    });
    expect(JSON.stringify(result)).not.toContain(internalId);
    expect(guardedByCriticalOp).toBe(true);
    expect(mocks.stopPrevious).toHaveBeenCalledWith({
      currentInstallId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      conflictPorts: [27432],
      signal: expect.any(AbortSignal),
    });
  });
});
