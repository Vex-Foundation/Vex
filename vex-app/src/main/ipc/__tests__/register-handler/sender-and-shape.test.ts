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

describe("registerHandler", () => {
  beforeEach(() => {
    handlers.clear();
    cleanupTasks.clear();
    errorMock.mockReset();
  });

  afterEach(() => {
    handlers.clear();
    cleanupTasks.clear();
  });

  it("returns ok on valid input + valid output", async () => {
    const registerHandler = await load();
    registerHandler({
      channel: "vex:test:ok",
      domain: "system",
      inputSchema: z.object({ name: z.string() }).strict(),
      outputSchema: z.object({ greeting: z.string() }).strict(),
      handle: async ({ name }) => ({
        ok: true as const,
        data: { greeting: `hi ${name}` },
      }),
    });
    const fn = handlers.get("vex:test:ok")!;
    const result = await fn(trustedSender, {
      requestId: "req-1",
      payload: { name: "world" },
    });
    expect(result).toEqual({ ok: true, data: { greeting: "hi world" } });
  });

  it("rejects untrusted sender with redacted error", async () => {
    const registerHandler = await load();
    registerHandler({
      channel: "vex:test:sender",
      domain: "system",
      inputSchema: z.object({}).strict(),
      handle: async () => ({ ok: true as const, data: undefined }),
    });
    const fn = handlers.get("vex:test:sender")!;
    const result: any = await fn(
      senderFrame("https://evil.com/"),
      { requestId: "r", payload: {} }
    );
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("validation.invalid_sender");
    expect(result.error.redacted).toBe(true);
    // Sender URL must NOT appear in the public error payload.
    expect(JSON.stringify(result.error)).not.toContain("evil.com");
    expect(errorMock).toHaveBeenCalled();
  });

  it("rejects trusted-origin subframes", async () => {
    const registerHandler = await load();
    registerHandler({
      channel: "vex:test:subframe",
      domain: "system",
      inputSchema: z.object({}).strict(),
      handle: async () => ({ ok: true as const, data: undefined }),
    });
    const fn = handlers.get("vex:test:subframe")!;
    const result: any = await fn(childSenderFrame("app://vex/index.html"), {
      requestId: "r",
      payload: {},
    });
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("validation.invalid_sender");
    expect(result.error.redacted).toBe(true);
  });

  it("rejects invalid input shape with redacted error", async () => {
    const registerHandler = await load();
    registerHandler({
      channel: "vex:test:input",
      domain: "system",
      inputSchema: z.object({ name: z.string() }).strict(),
      handle: async () => ({ ok: true as const, data: { greeting: "x" } }),
    });
    const fn = handlers.get("vex:test:input")!;
    const result: any = await fn(trustedSender, {
      requestId: "r",
      payload: { name: 123 },
    });
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("validation.invalid_input");
    expect(result.error.redacted).toBe(true);
  });

  it("flags handlers that produce wrong-shape Result.data", async () => {
    const registerHandler = await load();
    registerHandler({
      channel: "vex:test:output",
      domain: "system",
      inputSchema: z.object({}).strict(),
      outputSchema: z.object({ greeting: z.string() }).strict(),
      // Handler lies and returns wrong shape.
      handle: async () =>
        ({ ok: true, data: { wrong: "field" } }) as unknown as {
          ok: true;
          data: { greeting: string };
        },
    });
    const fn = handlers.get("vex:test:output")!;
    const result: any = await fn(trustedSender, {
      requestId: "r",
      payload: {},
    });
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("internal.contract_violation");
    expect(result.error.redacted).toBe(true);
  });

  it("rejects error shape with unknown VexErrorCode (closed-by-convention enum)", async () => {
    const registerHandler = await load();
    registerHandler({
      channel: "vex:test:bad-code",
      domain: "system",
      inputSchema: z.object({}).strict(),
      handle: async () =>
        ({
          ok: false,
          error: {
            code: "wallet.totally_fabricated_code",
            domain: "system",
            message: "x",
            retryable: false,
            userActionable: false,
            redacted: true,
          },
        }) as never,
    });
    const fn = handlers.get("vex:test:bad-code")!;
    const result: any = await fn(trustedSender, {
      requestId: "req-bad-code",
      payload: {},
    });
    expect(result.error.code).toBe("internal.contract_violation");
    expect(result.error.correlationId).toBe("req-bad-code");
  });

  it("rejects error shape with negative retryAfterMs", async () => {
    const registerHandler = await load();
    registerHandler({
      channel: "vex:test:bad-retry",
      domain: "wallet",
      inputSchema: z.object({}).strict(),
      handle: async () =>
        ({
          ok: false,
          error: {
            code: "wallet.export_throttled",
            domain: "wallet",
            message: "slow down",
            retryable: true,
            userActionable: true,
            redacted: true,
            retryAfterMs: -100,
          },
        }) as never,
    });
    const fn = handlers.get("vex:test:bad-retry")!;
    const result: any = await fn(trustedSender, {
      requestId: "req-bad-retry",
      payload: {},
    });
    expect(result.error.code).toBe("internal.contract_violation");
  });
});
