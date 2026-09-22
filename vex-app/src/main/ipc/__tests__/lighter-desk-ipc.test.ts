/**
 * Lighter desk lane IPC.
 *
 * Pinned invariants:
 *   - The renderer hands main a selector; main derives the prepare-tool
 *     terms itself (the same terms the ticket used to spell out in chat).
 *   - `ensureEngineDbUrl` first; bail with its Result when the DB is away.
 *   - The referenced session must EXIST, and that is the whole check: the
 *     trader's conversation follows them into the desk, so the session driving
 *     these buttons is ordinarily an agent one.
 *   - The engine's `prepareDeskApproval` outcome is returned as-is, and an
 *     engine throw becomes `internal.unexpected` rather than a fake refusal.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createTrustedSender, type TestIpcEvent } from "./test-sender.js";

type Handler = (event: TestIpcEvent, raw: unknown) => Promise<unknown>;
const handlers = vi.hoisted(() => new Map<string, Handler>());
const mocks = vi.hoisted(() => ({
  ensureEngineDbUrl: vi.fn(),
  getSessionById: vi.fn(),
  prepareDeskApproval: vi.fn(),
  prepareApprove: vi.fn(),
  resolveSessionAccount: vi.fn(),
  checkNonceRecovery: vi.fn(),
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
vi.mock("../../database/sessions-db.js", () => ({
  getSessionById: (...a: unknown[]) => mocks.getSessionById(...a),
}));
vi.mock("@vex-agent/engine/core/approval-runtime.js", () => ({
  prepareDeskApproval: (...a: unknown[]) => mocks.prepareDeskApproval(...a),
  prepareApprove: (...a: unknown[]) => mocks.prepareApprove(...a),
}));
vi.mock("../../lighter/session-account.js", () => ({
  resolveLighterSessionAccount: (...a: unknown[]) => mocks.resolveSessionAccount(...a),
}));
vi.mock("@vex-agent/tools/protocols/lighter/nonce-recovery.js", () => ({
  checkLighterNonceRecovery: (...a: unknown[]) => mocks.checkNonceRecovery(...a),
}));

const { registerLighterDeskHandlers, deskActionToPrepareCall } = await import(
  "../lighter-desk.js"
);
const { CH } = await import("@shared/ipc/channels.js");

const SESSION = "11111111-1111-4111-8111-111111111111";
const REQUEST_ID = "00000000-0000-4000-8000-000000000225";
let teardowns: ReadonlyArray<() => void> = [];
const sender = createTrustedSender();

type CallResult<T = unknown> = {
  readonly ok: boolean;
  readonly data: T;
  readonly error: { readonly code: string };
};

async function call<T = unknown>(payload: unknown): Promise<CallResult<T>> {
  const handler = handlers.get(CH.lighterTrading.prepareDeskAction);
  if (handler === undefined) throw new Error("desk handler not registered");
  return (await handler(sender, { requestId: REQUEST_ID, payload })) as CallResult<T>;
}

beforeEach(() => {
  vi.clearAllMocks();
  handlers.clear();
  mocks.ensureEngineDbUrl.mockResolvedValue({ ok: true, data: undefined });
  mocks.getSessionById.mockResolvedValue({
    ok: true,
    data: { id: SESSION, workspace: "lighter" },
  });
  mocks.prepareDeskApproval.mockResolvedValue({ kind: "enqueued", approvalId: "appr-1" });
  mocks.resolveSessionAccount.mockReset().mockResolvedValue(42);
  mocks.checkNonceRecovery.mockReset().mockResolvedValue({ status: "ready", message: "Pending actions checked." });
  teardowns = registerLighterDeskHandlers();
});

afterEach(() => {
  for (const teardown of teardowns) teardown();
});

describe("deskActionToPrepareCall", () => {
  it("close and cancel map to their prepare tools with main-owned defaults", () => {
    expect(deskActionToPrepareCall("rhc", { kind: "close", marketId: 7 })).toEqual({
      toolId: "lighter.position.close.prepare",
      params: { environment: "rhc", marketId: 7, slippageBps: 100 },
    });
    expect(
      deskActionToPrepareCall("rhc", { kind: "cancel", marketId: 7, orderId: "9001" }),
    ).toEqual({
      toolId: "lighter.order.cancel.prepare",
      params: { environment: "rhc", marketId: 7, orderId: "9001" },
    });
  });

  it("a market entry is an IOC preview at the worst price", () => {
    expect(
      deskActionToPrepareCall("rhc", {
        kind: "order",
        marketId: 7,
        draft: {
          mode: "market",
          side: "buy",
          baseAmount: "0.5",
          worstPrice: "3010.5",
          reduceOnly: false,
        },
      }),
    ).toEqual({
      toolId: "lighter.order.preview",
      params: {
        environment: "rhc",
        marketId: 7,
        side: "buy",
        baseAmountIn: "0.5",
        orderType: "market",
        timeInForce: "immediate-or-cancel",
        price: "3010.5",
        reduceOnly: false,
        orderExpiryOffsetMinutes: 30,
      },
    });
  });

  it("protective entries are reduce-only and rest for a day; oco goes to position.protect", () => {
    expect(
      deskActionToPrepareCall("core", {
        kind: "order",
        marketId: 1,
        draft: {
          mode: "stop-loss",
          side: "sell",
          baseAmount: "1",
          triggerPrice: "2900",
          worstPrice: "2880",
          reduceOnly: true,
        },
      }).params,
    ).toMatchObject({
      orderType: "stop-loss",
      triggerPrice: "2900",
      price: "2880",
      reduceOnly: true,
      orderExpiryOffsetMinutes: 1440,
    });
    expect(
      deskActionToPrepareCall("core", {
        kind: "order",
        marketId: 1,
        draft: {
          mode: "oco",
          side: "sell",
          baseAmount: "1",
          stopLossTriggerPrice: "2900",
          stopLossPrice: "2880",
          takeProfitTriggerPrice: "3200",
          takeProfitPrice: "3190",
        },
      }),
    ).toEqual({
      toolId: "lighter.position.protect",
      params: {
        environment: "core",
        marketId: 1,
        side: "sell",
        baseAmountIn: "1",
        stopLossTriggerPrice: "2900",
        stopLossPrice: "2880",
        takeProfitTriggerPrice: "3200",
        takeProfitPrice: "3190",
        orderExpiryOffsetMinutes: 1440,
      },
    });
  });
});

describe("vex:lighterTrading:prepareDeskAction", () => {
  it("hands the engine the derived call and returns its outcome", async () => {
    const result = await call({
      sessionId: SESSION,
      environment: "rhc",
      action: { kind: "close", marketId: 7 },
    });
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ kind: "enqueued", approvalId: "appr-1" });
    expect(mocks.prepareDeskApproval).toHaveBeenCalledWith({
      sessionId: SESSION,
      toolId: "lighter.position.close.prepare",
      params: { environment: "rhc", marketId: 7, slippageBps: 100, accountIndex: 42 },
    });
  });

  it("passes a refusal through untouched", async () => {
    mocks.prepareDeskApproval.mockResolvedValueOnce({
      kind: "refused",
      reason: "No open position in this market.",
    });
    const result = await call({
      sessionId: SESSION,
      environment: "rhc",
      action: { kind: "close", marketId: 7 },
    });
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({
      kind: "refused",
      reason: "No open position in this market.",
    });
  });

  it("joins concurrent identical submits so they cannot create two approval cards", async () => {
    let release: ((value: { kind: "enqueued"; approvalId: string }) => void) | undefined;
    mocks.prepareDeskApproval.mockImplementationOnce(
      () => new Promise((resolve) => { release = resolve; }),
    );
    const payload = {
      sessionId: SESSION,
      environment: "rhc",
      action: { kind: "close" as const, marketId: 7 },
    };

    const first = call(payload);
    await vi.waitFor(() => expect(mocks.prepareDeskApproval).toHaveBeenCalledTimes(1));
    const second = call(payload);
    release?.({ kind: "enqueued", approvalId: "appr-joined" });

    await expect(Promise.all([first, second])).resolves.toEqual([
      { ok: true, data: { kind: "enqueued", approvalId: "appr-joined" } },
      { ok: true, data: { kind: "enqueued", approvalId: "appr-joined" } },
    ]);
    expect(mocks.prepareDeskApproval).toHaveBeenCalledTimes(1);
  });

  it("refuses a session that no longer exists, before preparing", async () => {
    mocks.getSessionById.mockResolvedValueOnce({ ok: true, data: null });
    const result = await call({
      sessionId: SESSION,
      environment: "rhc",
      action: { kind: "close", marketId: 7 },
    });
    expect(result).toEqual({
      ok: true,
      data: {
        kind: "refused",
        reason: "This Lighter session is no longer available.",
      },
    });
    expect(mocks.prepareDeskApproval).not.toHaveBeenCalled();
  });

  /**
   * The conversation follows the trader into the desk, so the session behind
   * these buttons is ordinarily an AGENT session. Refusing it on the workspace
   * column - where the session was created - refused the desk's own everyday
   * use. Every control that was actually holding the line is elsewhere: the
   * selector, the prepare-tool whitelist, and the approval card.
   */
  it.each([
    ["a trade", { kind: "close" as const, marketId: 7 }],
    ["a setup step", { kind: "onboarding_deposit" as const, amountIn: "12" }],
  ])("prepares %s from the agent session carried into the desk", async (_label, action) => {
    mocks.getSessionById.mockResolvedValue({
      ok: true,
      data: { id: SESSION, workspace: null },
    });

    const result = await call({ sessionId: SESSION, environment: "rhc", action });

    expect(result).toEqual({ ok: true, data: { kind: "enqueued", approvalId: "appr-1" } });
  });

  it("rejects a renderer payload that carries terms outside the selector", async () => {
    const result = await call({
      sessionId: SESSION,
      environment: "rhc",
      action: { kind: "close", marketId: 7, slippageBps: 500 },
    });
    expect(result.ok).toBe(false);
    expect(mocks.prepareDeskApproval).not.toHaveBeenCalled();
  });

  it("bails on database unavailability before touching the engine", async () => {
    mocks.ensureEngineDbUrl.mockResolvedValueOnce({
      ok: false,
      error: { code: "internal.unexpected" },
    });
    const result = await call({
      sessionId: SESSION,
      environment: "rhc",
      action: { kind: "cancel", marketId: 7, orderId: "9001" },
    });
    expect(result.ok).toBe(false);
    expect(mocks.prepareDeskApproval).not.toHaveBeenCalled();
  });

  it("an engine throw is internal.unexpected, never a fake outcome", async () => {
    mocks.prepareDeskApproval.mockRejectedValueOnce(new Error("pg down"));
    const result = await call({
      sessionId: SESSION,
      environment: "rhc",
      action: { kind: "cancel", marketId: 7, orderId: "9001" },
    });
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("internal.unexpected");
  });
});

describe("desk prepare self-heals a stuck nonce reservation", () => {
  it("recovers the resolved session account before preparing an order, with no separate action", async () => {
    mocks.resolveSessionAccount.mockResolvedValueOnce(84);

    const result = await call({
      sessionId: SESSION,
      environment: "rhc",
      action: { kind: "close", marketId: 3 },
    });

    expect(mocks.checkNonceRecovery).toHaveBeenCalledWith({ environment: "rhc", accountIndex: 84 });
    expect(mocks.prepareDeskApproval).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
  });

  it("still prepares the card when the best-effort recovery check throws", async () => {
    mocks.resolveSessionAccount.mockResolvedValueOnce(84);
    mocks.checkNonceRecovery.mockRejectedValueOnce(new Error("internal-provider-response"));

    const result = await call({
      sessionId: SESSION,
      environment: "rhc",
      action: { kind: "close", marketId: 3 },
    });

    expect(mocks.prepareDeskApproval).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
    expect(JSON.stringify(result)).not.toContain("internal-provider-response");
  });
});
