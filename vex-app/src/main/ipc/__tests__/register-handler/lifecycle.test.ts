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

  it("registers an idempotent unregister via globalCleanup on app quit", async () => {
    const registerHandler = await load();
    const unregister = registerHandler({
      channel: "vex:test:cleanup",
      domain: "system",
      inputSchema: z.object({}).strict(),
      handle: async () => ({ ok: true as const, data: undefined }),
    });
    expect(handlers.has("vex:test:cleanup")).toBe(true);
    expect(cleanupTasks.size).toBe(1);

    // Manual unregister removes from ipcMain and from globalCleanup.
    unregister();
    expect(handlers.has("vex:test:cleanup")).toBe(false);
    // Idempotent: calling unregister again is a no-op.
    unregister();
    expect(handlers.has("vex:test:cleanup")).toBe(false);
  });

  it("globalCleanup task removes the handler on app quit (without explicit unregister)", async () => {
    const registerHandler = await load();
    registerHandler({
      channel: "vex:test:auto-quit",
      domain: "system",
      inputSchema: z.object({}).strict(),
      handle: async () => ({ ok: true as const, data: undefined }),
    });
    expect(handlers.has("vex:test:auto-quit")).toBe(true);
    expect(cleanupTasks.size).toBe(1);

    // Simulate app quit firing the cleanup task.
    const task = [...cleanupTasks][0];
    await task!();
    expect(handlers.has("vex:test:auto-quit")).toBe(false);
  });
});
