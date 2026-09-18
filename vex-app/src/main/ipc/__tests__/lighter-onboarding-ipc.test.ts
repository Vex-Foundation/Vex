/**
 * Lighter onboarding checklist IPC.
 *
 * Pinned invariants:
 *   - `ensureEngineDbUrl` first; bail with its Result when the DB is away.
 *   - The checklist is returned as-is; a read failure becomes a retryable
 *     `provider.unavailable`, never a fabricated checklist.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createTrustedSender, type TestIpcEvent } from "./test-sender.js";

type Handler = (event: TestIpcEvent, raw: unknown) => Promise<unknown>;
const handlers = vi.hoisted(() => new Map<string, Handler>());
const mocks = vi.hoisted(() => ({
  ensureEngineDbUrl: vi.fn(),
  resolveLighterOnboardingChecklist: vi.fn(),
}));

vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, handler: Handler) => handlers.set(channel, handler),
    removeHandler: (channel: string) => handlers.delete(channel),
  },
  app: { isPackaged: true },
}));
vi.mock("../../logger/index.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../../database/engine-db-readiness.js", () => ({
  ensureEngineDbUrl: (...a: unknown[]) => mocks.ensureEngineDbUrl(...a),
}));
vi.mock("../../lighter/onboarding-checklist.js", () => ({
  resolveLighterOnboardingChecklist: (...a: unknown[]) => mocks.resolveLighterOnboardingChecklist(...a),
}));

const { registerLighterOnboardingHandlers } = await import("../lighter-onboarding.js");
const { CH } = await import("@shared/ipc/channels.js");

const SESSION = "11111111-1111-4111-8111-111111111111";
const REQUEST_ID = "00000000-0000-4000-8000-000000000226";
let teardowns: ReadonlyArray<() => void> = [];
const sender = createTrustedSender();

type CallResult<T = unknown> = {
  readonly ok: boolean;
  readonly data: T;
  readonly error: { readonly code: string; readonly retryable: boolean };
};

async function call<T = unknown>(payload: unknown): Promise<CallResult<T>> {
  const handler = handlers.get(CH.lighterTrading.getOnboardingChecklist);
  if (handler === undefined) throw new Error("checklist handler not registered");
  return (await handler(sender, { requestId: REQUEST_ID, payload })) as CallResult<T>;
}

beforeEach(() => {
  vi.clearAllMocks();
  handlers.clear();
  mocks.ensureEngineDbUrl.mockResolvedValue({ ok: true, data: undefined });
  mocks.resolveLighterOnboardingChecklist.mockResolvedValue({
    deposit: "done",
    key: "todo",
    fee: "todo",
    progress: "action_required",
    detail: "Trading key approval is required.",
    nextAction: "continue_setup",
    updatedAt: null,
  });
  teardowns = registerLighterOnboardingHandlers();
});

afterEach(() => {
  for (const teardown of teardowns) teardown();
});

describe("vex:lighterTrading:getOnboardingChecklist", () => {
  it("returns the resolved checklist for the session and environment", async () => {
    const result = await call({ sessionId: SESSION, environment: "rhc" });
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({
      deposit: "done",
      key: "todo",
      fee: "todo",
      progress: "action_required",
      detail: "Trading key approval is required.",
      nextAction: "continue_setup",
      updatedAt: null,
    });
    expect(mocks.resolveLighterOnboardingChecklist).toHaveBeenCalledWith({ sessionId: SESSION, environment: "rhc" });
  });

  it("bails with the DB readiness result before reading anything", async () => {
    mocks.ensureEngineDbUrl.mockResolvedValue({
      ok: false,
      error: { code: "internal.unexpected", retryable: true },
    });
    const result = await call({ sessionId: SESSION, environment: "rhc" });
    expect(result.ok).toBe(false);
    expect(mocks.resolveLighterOnboardingChecklist).not.toHaveBeenCalled();
  });

  it("turns a read failure into a retryable provider error", async () => {
    mocks.resolveLighterOnboardingChecklist.mockRejectedValue(new Error("provider down"));
    const result = await call({ sessionId: SESSION, environment: "core" });
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("provider.unavailable");
    expect(result.error.retryable).toBe(true);
  });

  it("rejects a malformed request", async () => {
    const result = await call({ sessionId: "nope", environment: "rhc" });
    expect(result.ok).toBe(false);
    expect(mocks.resolveLighterOnboardingChecklist).not.toHaveBeenCalled();
  });
});
