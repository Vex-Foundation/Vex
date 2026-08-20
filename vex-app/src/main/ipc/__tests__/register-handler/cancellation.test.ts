/**
 * Unit tests for the IPC handler harness — covering the 5 critical paths
 * codex called out: invalid sender, invalid input, valid success, invalid
 * output shape, and thrown handler with redaction.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { z } from "zod";

// Capture handlers registered by registerHandler so tests can invoke them
// directly with a stubbed IpcMainInvokeEvent.
type Handler = (
  event: { senderFrame?: MockFrame },
  raw: unknown
) => unknown;

interface MockFrame {
  readonly url: string;
  readonly parent: MockFrame | null;
  readonly top: MockFrame | null;
}

const handlers = new Map<string, Handler>();
const errorMock = vi.fn();
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
  app: {
    isPackaged: true, // simulate prod - only app://vex/ origin is trusted
  },
}));

vi.mock("../../../logger/index.js", () => ({
  log: {
    error: (...args: unknown[]) => errorMock(...args),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    verbose: vi.fn(),
    silly: vi.fn(),
  },
}));

vi.mock("../../../lifecycle/cleanup-registry.js", () => ({
  globalCleanup: {
    add: (task: () => void | Promise<void>) => {
      cleanupTasks.add(task);
      return async () => {
        cleanupTasks.delete(task);
        await task();
      };
    },
  },
}));

async function load() {
  vi.resetModules();
  const mod = await import("../../register-handler.js");
  return mod.registerHandler;
}

function senderFrame(url: string): { senderFrame: MockFrame } {
  const frame: { url: string; parent: MockFrame | null; top: MockFrame | null } = {
    url,
    parent: null,
    top: null,
  };
  frame.top = frame;
  return { senderFrame: frame };
}

function childSenderFrame(url: string): { senderFrame: MockFrame } {
  const top = senderFrame(url).senderFrame;
  return {
    senderFrame: {
      url,
      parent: top,
      top,
    },
  };
}

const trustedSender = senderFrame("app://vex/index.html");

// ─── PR3: cancellation harness ─────────────────────────────────────────
//
// These cases prove the contract added in PR3:
//   - `ctx.signal` is always an AbortSignal (never undefined)
//   - aborting the signal mid-flight is visible to the handler
//   - AbortError thrown by the handler maps to `internal.cancelled`
//   - the cancel registry holds the controller during the in-flight
//     window and is cleaned in finally so late `vex:cancel` calls
//     return {cancelled: false}
//   - completed/failed requests cannot be retroactively cancelled

describe("registerHandler - cancellation (PR3)", () => {
  beforeEach(() => {
    handlers.clear();
    cleanupTasks.clear();
    errorMock.mockReset();
  });

  afterEach(() => {
    handlers.clear();
    cleanupTasks.clear();
  });

  it("passes a non-aborted AbortSignal to every handler invocation", async () => {
    const registerHandler = await load();
    let observedSignal: AbortSignal | undefined;
    registerHandler({
      channel: "vex:test:signal-shape",
      domain: "system",
      inputSchema: z.object({}).strict(),
      handle: async (_input, ctx) => {
        observedSignal = ctx.signal;
        return { ok: true as const, data: undefined };
      },
    });
    const fn = handlers.get("vex:test:signal-shape")!;
    await fn(trustedSender, { requestId: "req-signal", payload: {} });
    expect(observedSignal).toBeInstanceOf(AbortSignal);
    expect(observedSignal!.aborted).toBe(false);
  });

  it("getCancelController returns the controller while the handler is in flight", async () => {
    vi.resetModules();
    const { registerHandler, getCancelController } = await import(
      "../../register-handler.js"
    );
    let observedDuring: AbortController | undefined;
    let release: (() => void) | null = null;
    registerHandler({
      channel: "vex:test:registry-lookup",
      domain: "system",
      inputSchema: z.object({}).strict(),
      handle: async () => {
        observedDuring = getCancelController("req-lookup");
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return { ok: true as const, data: undefined };
      },
    });
    const fn = handlers.get("vex:test:registry-lookup")!;
    const pending = fn(trustedSender, { requestId: "req-lookup", payload: {} });
    // Yield once so the handler's first `await` is reached.
    await new Promise((r) => setTimeout(r, 0));
    expect(observedDuring).toBeInstanceOf(AbortController);
    // After completion the registry is empty for this id.
    release!();
    await pending;
    expect(getCancelController("req-lookup")).toBeUndefined();
  });

  it("normalizes a handler-thrown AbortError to internal.cancelled", async () => {
    const registerHandler = await load();
    registerHandler({
      channel: "vex:test:abort-throw",
      domain: "docker",
      inputSchema: z.object({}).strict(),
      handle: async () => {
        const e = new Error("aborted");
        e.name = "AbortError";
        throw e;
      },
    });
    const fn = handlers.get("vex:test:abort-throw")!;
    const result: any = await fn(trustedSender, {
      requestId: "req-abort",
      payload: {},
    });
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("internal.cancelled");
    expect(result.error.domain).toBe("docker");
    expect(result.error.correlationId).toBe("req-abort");
    expect(result.error.redacted).toBe(true);
    // Abort path must NOT be logged at error level — it's a normal
    // outcome of user cancel, not an internal failure.
    expect(errorMock).not.toHaveBeenCalled();
  });

  it("aborting the controller mid-flight propagates to ctx.signal", async () => {
    vi.resetModules();
    const { registerHandler, getCancelController } = await import(
      "../../register-handler.js"
    );
    let signalRef: AbortSignal | undefined;
    let proceed: (() => void) | null = null;
    registerHandler({
      channel: "vex:test:mid-flight-abort",
      domain: "docker",
      inputSchema: z.object({}).strict(),
      handle: async (_input, ctx) => {
        signalRef = ctx.signal;
        await new Promise<void>((resolve) => {
          proceed = resolve;
        });
        if (ctx.signal.aborted) {
          const e = new Error("aborted");
          e.name = "AbortError";
          throw e;
        }
        return { ok: true as const, data: undefined };
      },
    });
    const fn = handlers.get("vex:test:mid-flight-abort")!;
    const pending = fn(trustedSender, { requestId: "req-mid", payload: {} });
    await new Promise((r) => setTimeout(r, 0));
    expect(signalRef).toBeDefined();
    // Fetch the controller from the registry and fire abort.
    const controller = getCancelController("req-mid");
    expect(controller).toBeDefined();
    controller!.abort();
    proceed!();
    const result: any = await pending;
    expect(signalRef!.aborted).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("internal.cancelled");
  });

  it("if signal aborted and handler returned a non-cancelled error, code is rewritten to internal.cancelled", async () => {
    vi.resetModules();
    const { registerHandler, getCancelController } = await import(
      "../../register-handler.js"
    );
    let proceed: (() => void) | null = null;
    registerHandler({
      channel: "vex:test:abort-rewrite",
      domain: "docker",
      inputSchema: z.object({}).strict(),
      handle: async () => {
        await new Promise<void>((resolve) => {
          proceed = resolve;
        });
        // Handler returns a generic error — but its signal was
        // aborted, so registerHandler should rewrite the code.
        return {
          ok: false as const,
          error: {
            code: "internal.unexpected" as const,
            domain: "docker" as const,
            message: "something went wrong",
            retryable: false,
            userActionable: false,
            redacted: true as const,
          },
        };
      },
    });
    const fn = handlers.get("vex:test:abort-rewrite")!;
    const pending = fn(trustedSender, {
      requestId: "req-rewrite",
      payload: {},
    });
    await new Promise((r) => setTimeout(r, 0));
    const controller = getCancelController("req-rewrite");
    controller!.abort();
    proceed!();
    const result: any = await pending;
    expect(result.error.code).toBe("internal.cancelled");
    expect(result.error.correlationId).toBe("req-rewrite");
  });
});
