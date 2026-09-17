/**
 * Lighter funnel IPC.
 *
 * Pinned invariants:
 *   - Without Sentry consent the step is dropped: nothing captured, nothing
 *     logged, `recorded: false`.
 *   - With consent the step goes to Sentry as-is and `recorded` is Sentry's
 *     answer.
 *   - A step outside the enum is rejected at the boundary.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createTrustedSender, type TestIpcEvent } from "./test-sender.js";

type Handler = (event: TestIpcEvent, raw: unknown) => Promise<unknown>;
const handlers = vi.hoisted(() => new Map<string, Handler>());
const mocks = vi.hoisted(() => ({
  load: vi.fn(),
  captureFunnelStep: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, handler: Handler) => handlers.set(channel, handler),
    removeHandler: (channel: string) => handlers.delete(channel),
  },
  app: { isPackaged: true },
}));
vi.mock("../../logger/index.js", () => ({ log: mocks.log }));
vi.mock("../../preferences/store.js", () => ({
  preferencesStore: { load: () => mocks.load() },
}));
vi.mock("../../telemetry/sentry-lifecycle.js", () => ({
  captureFunnelStep: (...a: unknown[]) => mocks.captureFunnelStep(...a),
  captureRendererError: vi.fn(),
}));

const { registerFunnelHandler } = await import("../telemetry.js");
const { CH } = await import("@shared/ipc/channels.js");

const REQUEST_ID = "00000000-0000-4000-8000-000000000227";
let teardown: (() => void) | null = null;
const sender = createTrustedSender();

type CallResult = {
  readonly ok: boolean;
  readonly data: { readonly recorded: boolean };
  readonly error: { readonly code: string };
};

async function call(payload: unknown): Promise<CallResult> {
  const handler = handlers.get(CH.telemetry.funnelStep);
  if (handler === undefined) throw new Error("funnel handler not registered");
  return (await handler(sender, { requestId: REQUEST_ID, payload })) as CallResult;
}

beforeEach(() => {
  vi.clearAllMocks();
  handlers.clear();
  teardown = registerFunnelHandler();
});

afterEach(() => {
  teardown?.();
});

describe("vex:telemetry:funnelStep", () => {
  it("drops the step without consent: no capture, no log", async () => {
    mocks.load.mockResolvedValue({ telemetry: { enabled: false } });
    const result = await call({ step: "arena_banner", environment: "rhc" });
    expect(result).toEqual({ ok: true, data: { recorded: false } });
    expect(mocks.captureFunnelStep).not.toHaveBeenCalled();
    expect(mocks.log.info).not.toHaveBeenCalled();
    expect(mocks.log.error).not.toHaveBeenCalled();
  });

  it("forwards the step with consent and reports Sentry's answer", async () => {
    mocks.load.mockResolvedValue({ telemetry: { enabled: true } });
    mocks.captureFunnelStep.mockResolvedValue(true);
    const result = await call({ step: "desk_approve", environment: "core" });
    expect(result).toEqual({ ok: true, data: { recorded: true } });
    expect(mocks.captureFunnelStep).toHaveBeenCalledWith({ step: "desk_approve", environment: "core" });
  });

  it("rejects a step outside the enum at the boundary", async () => {
    mocks.load.mockResolvedValue({ telemetry: { enabled: true } });
    const result = await call({ step: "typed something", environment: "rhc" });
    expect(result.ok).toBe(false);
    expect(mocks.captureFunnelStep).not.toHaveBeenCalled();
  });
});
