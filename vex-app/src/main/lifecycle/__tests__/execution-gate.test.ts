/**
 * THE EXECUTION GATE: closed by construction, refuses every execution IPC
 * before the runtime is ready, opens once, and shutting down is one-way.
 *
 * The refusal is proven through the REAL `registerHandler`, because that is
 * the one path every IPC request takes: a gate that only its own unit knew
 * about would prove nothing about the handlers.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { CH } from "@shared/ipc/channels.js";
import type { Result } from "@shared/ipc/result.js";

type Handler = (event: { senderFrame?: MockFrame }, raw: unknown) => Promise<Result<unknown>>;

interface MockFrame {
  readonly url: string;
  readonly parent: MockFrame | null;
  readonly top: MockFrame | null;
}

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
  log: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("../cleanup-registry.js", () => ({
  globalCleanup: {
    add: () => async () => {},
  },
}));

type GateModule = typeof import("../execution-gate.js");
type RegisterHandler = typeof import("../../ipc/register-handler.js")["registerHandler"];

async function load(): Promise<{ gate: GateModule; registerHandler: RegisterHandler }> {
  vi.resetModules();
  const gate = await import("../execution-gate.js");
  const { registerHandler } = await import("../../ipc/register-handler.js");
  return { gate, registerHandler };
}

function trustedSender(): { senderFrame: MockFrame } {
  const frame: { url: string; parent: MockFrame | null; top: MockFrame | null } = {
    url: "app://vex/index.html",
    parent: null,
    top: null,
  };
  frame.top = frame;
  return { senderFrame: frame };
}

function requireHandler(channel: string): Handler {
  const handler = handlers.get(channel);
  if (handler === undefined) throw new Error(`no handler registered for ${channel}`);
  return handler;
}

function registerProbe(registerHandler: RegisterHandler, channel: string): ReturnType<typeof vi.fn> {
  const body = vi.fn(async () => ({ ok: true as const, data: { ran: true } }));
  registerHandler({
    channel,
    domain: "system",
    inputSchema: z.object({}).strict(),
    handle: body,
  });
  return body;
}

async function invoke(channel: string, requestId: string): Promise<Result<unknown>> {
  return requireHandler(channel)(trustedSender(), { requestId, payload: {} });
}

describe("execution gate", () => {
  beforeEach(() => {
    handlers.clear();
  });
  afterEach(() => {
    handlers.clear();
  });

  it("is CLOSED the moment the module is evaluated", async () => {
    const { gate } = await load();
    expect(gate.executionGateState()).toBe("starting");
    expect(gate.isExecutionGateOpen()).toBe(false);
  });

  it("refuses EVERY execution channel before the runtime is ready, without running the handler", async () => {
    const { gate, registerHandler } = await load();
    const bodies = new Map<string, ReturnType<typeof vi.fn>>();
    for (const channel of gate.EXECUTION_GATED_CHANNELS) {
      bodies.set(channel, registerProbe(registerHandler, channel));
    }
    expect(bodies.size).toBe(gate.EXECUTION_GATED_CHANNELS.size);

    for (const [channel, body] of bodies) {
      const requestId = `req-${channel}`;
      const result = await invoke(channel, requestId);
      expect(result.ok, channel).toBe(false);
      if (result.ok) continue;
      expect(result.error.code, channel).toBe("services.runtime_starting");
      expect(result.error.retryable, channel).toBe(true);
      expect(result.error.userActionable, channel).toBe(true);
      expect(result.error.correlationId, channel).toBe(requestId);
      expect(result.error.message, channel).toContain("Nothing was executed");
      expect(body, channel).not.toHaveBeenCalled();
    }
  });

  it("admits the same channels once the gate opens", async () => {
    const { gate, registerHandler } = await load();
    const body = registerProbe(registerHandler, CH.approvals.approve);
    expect((await invoke(CH.approvals.approve, "r1")).ok).toBe(false);
    expect(gate.openExecutionGate()).toBe(true);
    const result = await invoke(CH.approvals.approve, "r2");
    expect(result).toEqual({ ok: true, data: { ran: true } });
    expect(body).toHaveBeenCalledTimes(1);
    // Opening is idempotent and reports that it did nothing the second time.
    expect(gate.openExecutionGate()).toBe(false);
  });

  it("never gates the brakes or the reads while closed", async () => {
    const { gate, registerHandler } = await load();
    const ungated = [
      ...gate.EXECUTION_GATE_EXEMPT_CHANNELS,
      CH.approvals.listPending,
      CH.runtime.getState,
      CH.docker.detect,
      CH.docker.composeUp,
      CH.database.migrate,
      CH.secrets.unlock,
    ];
    for (const channel of ungated) {
      expect(gate.isExecutionGatedChannel(channel), channel).toBe(false);
      const body = registerProbe(registerHandler, channel);
      const result = await invoke(channel, `req-${channel}`);
      expect(result.ok, channel).toBe(true);
      expect(body, channel).toHaveBeenCalledTimes(1);
    }
  });

  it("shutting down is one-way: nothing reopens it, and the refusal is not retryable", async () => {
    const { gate, registerHandler } = await load();
    gate.openExecutionGate();
    gate.closeExecutionGateForShutdown();
    expect(gate.openExecutionGate()).toBe(false);
    expect(gate.executionGateState()).toBe("shutting_down");
    const body = registerProbe(registerHandler, CH.chat.submit);
    const result = await invoke(CH.chat.submit, "r3");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("services.runtime_starting");
      expect(result.error.retryable).toBe(false);
    }
    expect(body).not.toHaveBeenCalled();
  });
});

describe("armExecutionGate", () => {
  function deferred(): { promise: Promise<void>; resolve: () => void; reject: (cause: Error) => void } {
    let resolve: () => void = () => {};
    let reject: (cause: Error) => void = () => {};
    const promise = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  it("opens only after the database AND the Studio barrier, in that order", async () => {
    const { gate } = await load();
    const db = deferred();
    const studio = deferred();
    const studioCalled = vi.fn();
    const arm = gate.armExecutionGate({
      whenEngineDbReady: () => db.promise,
      whenStudioRuntimeSettled: () => {
        studioCalled();
        return studio.promise;
      },
    });
    await Promise.resolve();
    expect(gate.isExecutionGateOpen()).toBe(false);
    expect(studioCalled).not.toHaveBeenCalled();

    db.resolve();
    await vi.waitFor(() => expect(studioCalled).toHaveBeenCalledTimes(1));
    expect(gate.isExecutionGateOpen()).toBe(false);

    studio.resolve();
    await arm.settled;
    expect(gate.isExecutionGateOpen()).toBe(true);
  });

  it("an abort (quit) during the wait keeps the gate closed", async () => {
    const { gate } = await load();
    const db = deferred();
    const arm = gate.armExecutionGate({
      whenEngineDbReady: ({ signal }) => {
        signal.addEventListener("abort", () => db.reject(new Error("aborted")));
        return db.promise;
      },
      whenStudioRuntimeSettled: () => Promise.resolve(),
    });
    arm.abort();
    await arm.settled;
    expect(gate.isExecutionGateOpen()).toBe(false);
  });

  it("an abort after the database is ready still keeps the gate closed", async () => {
    const { gate } = await load();
    const studio = deferred();
    const arm = gate.armExecutionGate({
      whenEngineDbReady: () => Promise.resolve(),
      whenStudioRuntimeSettled: () => studio.promise,
    });
    await Promise.resolve();
    arm.abort();
    studio.resolve();
    await arm.settled;
    expect(gate.isExecutionGateOpen()).toBe(false);
  });

  it("a failed wait never throws at its caller and leaves the gate closed", async () => {
    const { gate } = await load();
    const arm = gate.armExecutionGate({
      whenEngineDbReady: () => Promise.reject(new Error("boom")),
      whenStudioRuntimeSettled: () => Promise.resolve(),
    });
    await expect(arm.settled).resolves.toBeUndefined();
    expect(gate.isExecutionGateOpen()).toBe(false);
  });
});

/**
 * Every request channel whose ACTION reads like it starts work must be either
 * gated or explicitly exempt, so a new execution channel cannot slip past the
 * gate by being forgotten. The names below match the verb pattern but start no
 * agent, tool or wallet work; each says why.
 */
const NOT_EXECUTION: ReadonlySet<string> = new Set<string>([
  CH.docker.start, // starts Docker itself: the runtime the gate waits for
  CH.docker.stopPreviousInstallStacks, // runtime housekeeping, no agent work
  CH.mission.acceptContract, // binds the contract; `start` is what runs it
  CH.compaction.retry, // re-enqueues a memory job, never a tool or a signature
  CH.compaction.requestApply, // transcript maintenance under its own gates
  CH.poolsLaunch.prepare, // a preview; `deploy` is the consent
  CH.poolsLaunch.claimPreview, // read-only preview of a claim
  CH.settings.prepareLighterLeverage, // a preview; `confirm` signs
  CH.lighterTrading.startCandleSubscription, // public market data
  CH.lighterTrading.stopCandleSubscription,
  CH.lighterTrading.startPublicMarketSubscription,
  CH.lighterTrading.stopPublicMarketSubscription,
  CH.lighterTrading.reconcileKeyRegistration, // recovery read of a past step
  CH.lighterTrading.reconcileSetup,
  CH.settings.reconcileLighterLeverage,
  CH.updater.startUpdateNow, // the app updater, not agent work
  CH.updater.cancelDownload,
  CH.updater.restartAndInstallNow,
  CH.terminal.confirmPort, // a terminal data-plane handshake
]);

const EXECUTION_VERB =
  /^(submit|steer|approve|reject|start|stop|continue|recover|renew|retry|restart|resume|request|deploy|claim|confirm|cancel|execute|settle|prepare|accept)/i;

function requestChannels(): ReadonlyArray<string> {
  const out: string[] = [];
  for (const group of Object.values(CH)) {
    if (typeof group === "string") continue;
    for (const [action, channel] of Object.entries(group)) {
      if (EXECUTION_VERB.test(action)) out.push(channel);
    }
  }
  return out;
}

describe("execution gate coverage", () => {
  it("classifies every execution-shaped request channel", async () => {
    const { gate } = await load();
    const unclassified = requestChannels().filter(
      (channel) =>
        !gate.EXECUTION_GATED_CHANNELS.has(channel)
        && !gate.EXECUTION_GATE_EXEMPT_CHANNELS.has(channel)
        && !NOT_EXECUTION.has(channel),
    );
    expect(unclassified).toEqual([]);
  });

  it("no channel is both gated and exempt", async () => {
    const { gate } = await load();
    for (const channel of gate.EXECUTION_GATED_CHANNELS) {
      expect(gate.EXECUTION_GATE_EXEMPT_CHANNELS.has(channel), channel).toBe(false);
    }
  });
});
