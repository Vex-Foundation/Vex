/**
 * Handler-level tests for the `vex:docker:composeUp` cancellation
 * contract added in PR3.
 *
 * Covers the three scenarios Codex turn 14 demanded:
 *   1. Initiator cancel while the mocked lifecycle.composeUp resolves
 *      AFTER signal.aborted → handler returns `internal.cancelled`.
 *   2. Joined caller's cancel detaches THAT caller only — the shared
 *      composeUpInFlight continues, the initiator still sees the
 *      eventual result.
 *   3. Initiator cancel propagates to joined callers (they all see
 *      `internal.cancelled`).
 *
 * The full compose stack is mocked out: we only care about the
 * handler's branching around `ctx.signal` and the single-flight join.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Handler = (
  event: { senderFrame: { url: string; parent: null; top: any } },
  raw: unknown,
) => unknown;

const handlers = new Map<string, Handler>();
const cleanupTasks = new Set<() => void | Promise<void>>();

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
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    verbose: vi.fn(),
    silly: vi.fn(),
  },
}));

vi.mock("../../lifecycle/cleanup-registry.js", () => ({
  globalCleanup: {
    add: (task: () => void | Promise<void>) => {
      cleanupTasks.add(task);
      return async () => {
        cleanupTasks.delete(task);
      };
    },
  },
}));

vi.mock("../../lifecycle/broadcast.js", () => ({
  broadcastToAllWindows: vi.fn(),
}));

vi.mock("../../database/connection-state.js", () => ({
  setDbConnection: vi.fn(),
}));

vi.mock("../../compose/deps-factory.js", () => ({
  buildRenderDeps: () => ({ userDataDir: "/tmp/fake-user-data" }),
}));

vi.mock("../../docker/probe.js", () => ({
  probeDocker: vi.fn(),
}));

vi.mock("../../docker/install.js", () => ({
  performInstall: vi.fn(),
}));

vi.mock("../../docker/start.js", () => ({
  performStart: vi.fn(),
}));

vi.mock("../../docker/progress-bus.js", () => ({
  composeLogBus: {
    emit: vi.fn(),
    subscribe: () => () => {},
  },
  dockerProgressBus: {
    emit: vi.fn(),
    subscribe: () => () => {},
  },
}));

const composeMock = vi.fn();
vi.mock("../../compose/lifecycle.js", () => ({
  composeUp: composeMock,
  composeDown: vi.fn(),
}));

function trustedSender(): { senderFrame: { url: string; parent: null; top: any } } {
  const frame: { url: string; parent: null; top: any } = {
    url: "app://vex/index.html",
    parent: null,
    top: null,
  };
  frame.top = frame;
  return { senderFrame: frame };
}

const UUID_INITIATOR = "11111111-2222-4333-8444-555555555555";
const UUID_JOINER_A = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const UUID_JOINER_B = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";

async function loadHandler(): Promise<Handler> {
  vi.resetModules();
  const { __resetCancelRegistryForTests } = await import("../register-handler.js");
  __resetCancelRegistryForTests();
  const { registerDockerHandlers } = await import("../docker.js");
  registerDockerHandlers();
  const fn = handlers.get("vex:docker:composeUp");
  if (fn === undefined) throw new Error("composeUp handler not registered");
  return fn;
}

function successResult(): {
  kind: "running";
  composeOutPath: string;
  installId: string;
  message: string;
  previousInstallHoldingPorts: boolean;
  conflictPorts: ReadonlyArray<number>;
  pgPort: number;
  embedPort: number;
  pgPasswordPath: string;
  embeddingsReadiness: "ready";
} {
  return {
    kind: "running" as const,
    composeOutPath: "/tmp/out/docker-compose.yml",
    installId: "fake-install-id",
    message: "Vex stack is running.",
    previousInstallHoldingPorts: false,
    conflictPorts: [],
    pgPort: 27432,
    embedPort: 27134,
    pgPasswordPath: "/tmp/secrets/pg_password",
    embeddingsReadiness: "ready" as const,
  };
}

function failedResult(message: string): ReturnType<typeof successResult> {
  return {
    ...successResult(),
    // We DELIBERATELY return a "running" kind here so the test can
    // verify that registerHandler converts it to cancelled when the
    // signal aborted (it's the IIFE post-hoc throw + handler catch
    // that should override this).
    kind: "running" as const,
    message,
  };
}

beforeEach(() => {
  handlers.clear();
  cleanupTasks.clear();
  composeMock.mockReset();
});

afterEach(() => {
  handlers.clear();
  cleanupTasks.clear();
});

describe("docker:composeUp - cancellation (PR3)", () => {
  it("initiator cancel - composeUp resolves after signal.aborted → handler returns internal.cancelled", async () => {
    const composeUpFn = await loadHandler();
    const { getCancelController } = await import("../register-handler.js");

    // lifecycle.composeUp ignores the abort and resolves normally,
    // mimicking runSpawn's `{aborted: true}` → ok({kind: "failed"})
    // collapse. The handler's IIFE wrap must STILL surface this as
    // internal.cancelled because ctx.signal.aborted is true.
    let release: (() => void) | null = null;
    composeMock.mockImplementation(async (_deps: unknown, opts: { signal?: AbortSignal }) => {
      // Park until the test releases us, then resolve with a fake
      // "running" result — proves we don't depend on lifecycle
      // throwing AbortError itself.
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      // Note: opts.signal is referenced to demonstrate it WAS passed
      // through; the mock chooses to ignore it.
      void opts;
      return successResult();
    });

    const pending = composeUpFn(trustedSender(), {
      requestId: UUID_INITIATOR,
      payload: {},
    });
    // Deterministic: wait until the handler actually reached the mock body
    // (release assigned) — a bare zero-yield races under machine load and
    // `release!()` on null produced unhandled TypeErrors + timeouts.
    await vi.waitFor(() => {
      expect(release).not.toBeNull();
    });

    const controller = getCancelController(UUID_INITIATOR);
    expect(controller).toBeDefined();
    controller!.abort();
    release!();

    const result: any = await pending;
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("internal.cancelled");
    expect(result.error.domain).toBe("docker");
    expect(result.error.correlationId).toBe(UUID_INITIATOR);
  });

  it("joined caller cancel detaches THAT caller only - shared work continues for initiator", async () => {
    const composeUpFn = await loadHandler();
    const { getCancelController } = await import("../register-handler.js");

    // One slow-running composeUp; only the first call to the mock
    // actually executes the function body (single-flight join takes
    // the second invocation through the join path).
    let release: (() => void) | null = null;
    composeMock.mockImplementation(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return successResult();
    });

    const initiatorPending = composeUpFn(trustedSender(), {
      requestId: UUID_INITIATOR,
      payload: {},
    });
    // Deterministic: the initiator has registered its in-flight once the
    // mock body ran (in-flight is set before lifecycle.composeUp is
    // invoked) — a bare zero-yield let the joiner race ahead under load.
    await vi.waitFor(() => {
      expect(composeMock).toHaveBeenCalledTimes(1);
    });

    const joinerPending = composeUpFn(trustedSender(), {
      requestId: UUID_JOINER_A,
      payload: {},
    });
    await new Promise((r) => setTimeout(r, 0));

    // composeUp lifecycle was called exactly once (joiner joined).
    expect(composeMock).toHaveBeenCalledTimes(1);

    // Joiner cancels their wait. Initiator is unaffected.
    const joinerCtrl = getCancelController(UUID_JOINER_A);
    expect(joinerCtrl).toBeDefined();
    joinerCtrl!.abort();

    const joinerResult: any = await joinerPending;
    expect(joinerResult.ok).toBe(false);
    expect(joinerResult.error.code).toBe("internal.cancelled");
    expect(joinerResult.error.correlationId).toBe(UUID_JOINER_A);

    // Initiator's signal is NOT aborted; its result resolves
    // normally when the mock unblocks.
    release!();
    const initiatorResult: any = await initiatorPending;
    expect(initiatorResult.ok).toBe(true);
    expect(initiatorResult.data.kind).toBe("running");
  });

  it("initiator cancel propagates to joined callers (they all see internal.cancelled)", async () => {
    const composeUpFn = await loadHandler();
    const { getCancelController } = await import("../register-handler.js");

    let release: (() => void) | null = null;
    composeMock.mockImplementation(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      // Resolve to a "running" — handler's IIFE should still wrap
      // it into AbortError because ctx.signal.aborted is true at
      // the time of resolution.
      return failedResult("would have been a real failure, but we cancelled first");
    });

    const initiatorPending = composeUpFn(trustedSender(), {
      requestId: UUID_INITIATOR,
      payload: {},
    });
    await new Promise((r) => setTimeout(r, 0));

    const joinerAPending = composeUpFn(trustedSender(), {
      requestId: UUID_JOINER_A,
      payload: {},
    });
    const joinerBPending = composeUpFn(trustedSender(), {
      requestId: UUID_JOINER_B,
      payload: {},
    });
    await new Promise((r) => setTimeout(r, 0));

    expect(composeMock).toHaveBeenCalledTimes(1);

    // Initiator aborts BEFORE the mock unblocks.
    const initiatorCtrl = getCancelController(UUID_INITIATOR);
    initiatorCtrl!.abort();
    release!();

    const [initiatorResult, joinerAResult, joinerBResult]: any[] =
      await Promise.all([initiatorPending, joinerAPending, joinerBPending]);
    expect(initiatorResult.ok).toBe(false);
    expect(initiatorResult.error.code).toBe("internal.cancelled");
    // Joiners see the shared promise's AbortError rejection through
    // their raceWithAbort, which surfaces as internal.cancelled.
    expect(joinerAResult.ok).toBe(false);
    expect(joinerAResult.error.code).toBe("internal.cancelled");
    expect(joinerBResult.ok).toBe(false);
    expect(joinerBResult.error.code).toBe("internal.cancelled");
    // Correlation ids are per-request, not collapsed onto the
    // initiator's id.
    expect(joinerAResult.error.correlationId).toBe(UUID_JOINER_A);
    expect(joinerBResult.error.correlationId).toBe(UUID_JOINER_B);
  });
});
