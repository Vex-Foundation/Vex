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
  resolveLighterAccountSetupStatus: vi.fn(),
  getPendingForSession: vi.fn(),
  getLighterSetupInteraction: vi.fn(),
  settleIfPendingWith: vi.fn(),
  resumeAgentAfterLighterSetup: vi.fn(),
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
  resolveLighterAccountSetupStatus: (...a: unknown[]) => mocks.resolveLighterAccountSetupStatus(...a),
}));
vi.mock("@vex-agent/db/repos/lighter-setup-interactions.js", () => ({
  getPendingForSession: (...a: unknown[]) => mocks.getPendingForSession(...a),
  getById: (...a: unknown[]) => mocks.getLighterSetupInteraction(...a),
  settleIfPendingWith: (...a: unknown[]) => mocks.settleIfPendingWith(...a),
}));
vi.mock("@vex-agent/engine/runtime/lease-and-status.js", () => ({
  withSessionControlLock: async (_sessionId: string, fn: (client: unknown) => Promise<unknown>) => fn({}),
}));
vi.mock("@vex-agent/engine/core/lighter-setup-resume.js", () => ({
  resumeAgentAfterLighterSetup: (...a: unknown[]) => mocks.resumeAgentAfterLighterSetup(...a),
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

async function call<T = unknown>(
  payload: unknown,
  channel: string = CH.lighterTrading.getOnboardingChecklist,
): Promise<CallResult<T>> {
  const handler = handlers.get(channel);
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
  mocks.getPendingForSession.mockResolvedValue(null);
  mocks.getLighterSetupInteraction.mockResolvedValue({
    intentId: "22222222-2222-4222-8222-222222222222",
    sessionId: SESSION,
    toolCallId: "call_setup",
    environment: "core",
    status: "pending",
    resultMessageId: null,
    resumeConsumedAt: null,
  });
  mocks.resolveLighterAccountSetupStatus.mockResolvedValue({
    accountExists: true,
    tradingKeyRegistered: true,
    feeAuthorized: true,
  });
  mocks.settleIfPendingWith.mockResolvedValue({ status: "completed" });
  mocks.resumeAgentAfterLighterSetup.mockResolvedValue({ resumed: true });
  teardowns = registerLighterOnboardingHandlers();
});

describe("Agent Lighter setup continuation", () => {
  /**
   * The agent picks an environment to OPEN the modal with - for a request that
   * named none, the default. The user may then move the modal's own toggle, so
   * the deployment to verify is the one the modal says it finished, not the
   * agent's opening guess, and the row is re-pointed at it so the resumed turn
   * names the account the user actually set up.
   */
  it("verifies and records the environment the modal finished on", async () => {
    const intentId = "22222222-2222-4222-8222-222222222222";
    mocks.resumeAgentAfterLighterSetup.mockReturnValueOnce(new Promise(() => undefined));

    const result = await call(
      { sessionId: SESSION, intentId, outcome: "completed", environment: "rhc" },
      CH.lighterTrading.settleAgentSetup,
    );

    expect(result.ok).toBe(true);
    // The row says "core"; the modal finished "rhc", and rhc is what counts.
    expect(mocks.resolveLighterAccountSetupStatus).toHaveBeenCalledWith({
      sessionId: SESSION,
      environment: "rhc",
    });
    expect(mocks.settleIfPendingWith).toHaveBeenCalledWith(
      expect.anything(),
      intentId,
      SESSION,
      "completed",
      "rhc",
    );
  });

  it("refuses a switched environment that is not actually set up", async () => {
    mocks.resolveLighterAccountSetupStatus.mockResolvedValue({
      accountExists: true,
      tradingKeyRegistered: false,
      feeAuthorized: false,
    });

    const result = await call(
      {
        sessionId: SESSION,
        intentId: "22222222-2222-4222-8222-222222222222",
        outcome: "completed",
        environment: "rhc",
      },
      CH.lighterTrading.settleAgentSetup,
    );

    expect(result.ok).toBe(false);
    expect(mocks.settleIfPendingWith).not.toHaveBeenCalled();
  });

  it("returns the pending interaction for renderer recovery", async () => {
    mocks.getPendingForSession.mockResolvedValue({
      intentId: "22222222-2222-4222-8222-222222222222",
      sessionId: SESSION,
      environment: "rhc",
      status: "pending",
      createdAt: "2026-09-20T13:00:00.000Z",
    });
    const result = await call(
      { sessionId: SESSION },
      CH.lighterTrading.getPendingAgentSetup,
    );
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ interaction: { environment: "rhc" } });
  });

  it("re-verifies completed setup before settling and resuming", async () => {
    const intentId = "22222222-2222-4222-8222-222222222222";
    // A resumed model turn can be long-running. The settlement response must
    // still return as soon as the durable CAS succeeds.
    mocks.resumeAgentAfterLighterSetup.mockReturnValueOnce(new Promise(() => undefined));
    const result = await call(
      { sessionId: SESSION, intentId, outcome: "completed" },
      CH.lighterTrading.settleAgentSetup,
    );
    expect(result.ok).toBe(true);
    expect(mocks.resolveLighterAccountSetupStatus).toHaveBeenCalledWith({
      sessionId: SESSION,
      environment: "core",
    });
    expect(mocks.settleIfPendingWith).toHaveBeenCalledWith(
      expect.anything(),
      intentId,
      SESSION,
      "completed",
      "core",
    );
    expect(mocks.resumeAgentAfterLighterSetup).toHaveBeenCalledWith({
      intentId,
      sessionId: SESSION,
    });
    expect(result.data).toMatchObject({
      settled: true,
      resumedAgentTurn: false,
    });
  });

  it("refuses a false completed claim and leaves the turn parked", async () => {
    mocks.resolveLighterAccountSetupStatus.mockResolvedValue({
      accountExists: true,
      tradingKeyRegistered: false,
      feeAuthorized: false,
    });
    const result = await call(
      {
        sessionId: SESSION,
        intentId: "22222222-2222-4222-8222-222222222222",
        outcome: "completed",
      },
      CH.lighterTrading.settleAgentSetup,
    );
    expect(result.ok).toBe(false);
    expect(mocks.settleIfPendingWith).not.toHaveBeenCalled();
    expect(mocks.resumeAgentAfterLighterSetup).not.toHaveBeenCalled();
  });

  it("cancels deliberately without pretending setup completed", async () => {
    const intentId = "22222222-2222-4222-8222-222222222222";
    await call(
      { sessionId: SESSION, intentId, outcome: "cancelled" },
      CH.lighterTrading.settleAgentSetup,
    );
    expect(mocks.resolveLighterAccountSetupStatus).not.toHaveBeenCalled();
    expect(mocks.settleIfPendingWith).toHaveBeenCalledWith(
      expect.anything(),
      intentId,
      SESSION,
      "cancelled",
      // Nothing was set up anywhere, so the row claims no environment.
      undefined,
    );
  });
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
