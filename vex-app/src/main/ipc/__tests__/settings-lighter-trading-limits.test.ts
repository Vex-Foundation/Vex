/**
 * The Lighter trading-setup IPC contract: what the boundary accepts, what it
 * refuses, and what it hands back.
 *
 * The renderer is untrusted here, so the negative cases carry the weight: an
 * unknown field, a share outside 1..100, a leverage the schema does not admit,
 * and a sender that is not a trusted frame all have to be refused BEFORE the
 * owner is ever called.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { defaultPreferences, type Preferences } from "@shared/schemas/preferences.js";
import {
  createMainFrame,
  createTestWebContents,
  createTrustedSender,
  type TestIpcEvent,
} from "./test-sender.js";

type Handler = (event: TestIpcEvent, raw: unknown) => Promise<unknown>;
const handlers = vi.hoisted(() => new Map<string, Handler>());
const state = vi.hoisted(() => ({ preferences: null as Preferences | null }));
const mocks = vi.hoisted(() => ({
  ensureEngineDbUrl: vi.fn(),
  readLighterTradingLimits: vi.fn(),
  writeLighterTradingLimits: vi.fn(),
  getLighterLeverageOverview: vi.fn(),
  prepareLighterLeverage: vi.fn(),
  confirmLighterLeverage: vi.fn(),
  reconcileLighterLeverage: vi.fn(),
}));

vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, handler: Handler) => handlers.set(channel, handler),
    removeHandler: (channel: string) => handlers.delete(channel),
  },
  app: { isPackaged: true },
  dialog: { showMessageBox: vi.fn(async () => ({ response: 0 })) },
}));
vi.mock("../../preferences/store.js", () => ({
  preferencesStore: { load: async () => state.preferences, update: async () => state.preferences },
}));
vi.mock("../../telemetry/sentry-lifecycle.js", () => ({
  disableSentry: vi.fn(),
  initSentryIfConsented: vi.fn(),
}));
vi.mock("../../logger/index.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../../database/engine-db-readiness.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../database/engine-db-readiness.js")>()),
  ensureEngineDbUrl: (...args: unknown[]) => mocks.ensureEngineDbUrl(...args),
}));
vi.mock("@vex-lib/wallet.js", () => ({ getPrimaryEvmAddress: () => null }));
vi.mock("@vex-agent/db/repos/lighter-trading-limits.js", () => ({
  readLighterTradingLimits: (...args: unknown[]) => mocks.readLighterTradingLimits(...args),
  writeLighterTradingLimits: (...args: unknown[]) => mocks.writeLighterTradingLimits(...args),
}));
vi.mock("../../lighter/leverage-preparation.js", () => ({
  getLighterLeverageOverview: (...args: unknown[]) => mocks.getLighterLeverageOverview(...args),
  prepareLighterLeverage: (...args: unknown[]) => mocks.prepareLighterLeverage(...args),
}));
vi.mock("../../lighter/leverage-execution.js", () => ({
  confirmLighterLeverage: (...args: unknown[]) => mocks.confirmLighterLeverage(...args),
  reconcileLighterLeverage: (...args: unknown[]) => mocks.reconcileLighterLeverage(...args),
}));

const { registerSettingsHandlers } = await import("../settings.js");
const { CH } = await import("@shared/ipc/channels.js");
const { ErrorCodes, VexError } = await import("../../../../../src/errors.js");

const WALLET = "0x1111111111111111111111111111111111111111";
const sender = createTrustedSender({ sender: createTestWebContents() });

type CallResult = {
  readonly ok: boolean;
  readonly data?: Record<string, unknown>;
  readonly error?: {
    readonly code: string;
    readonly message: string;
    readonly retryable?: boolean;
  };
};

async function call(
  channel: string,
  payload: unknown,
  event: TestIpcEvent = sender,
): Promise<CallResult> {
  const handler = handlers.get(channel);
  if (handler === undefined) throw new Error(`Handler not registered: ${channel}`);
  return (await handler(event, {
    requestId: "00000000-0000-4000-8000-000000000501",
    payload,
  })) as CallResult;
}

beforeEach(() => {
  vi.clearAllMocks();
  handlers.clear();
  state.preferences = structuredClone(defaultPreferences);
  mocks.ensureEngineDbUrl.mockResolvedValue({ ok: true, data: undefined });
  mocks.readLighterTradingLimits.mockResolvedValue(null);
  registerSettingsHandlers();
});

describe("settings.getLighterTradingLimits", () => {
  it("reports no ceiling and a null revision when the wallet has no stored row", async () => {
    const result = await call(CH.settings.getLighterTradingLimits, {
      environment: "rhc",
      walletAddress: WALLET,
    });

    expect(result).toEqual({
      ok: true,
      data: {
        environment: "rhc",
        walletAddress: WALLET,
        agentCapitalSharePercent: null,
        revision: null,
      },
    });
  });

  it("returns the stored share and its revision", async () => {
    mocks.readLighterTradingLimits.mockResolvedValueOnce({
      environment: "rhc",
      walletAddress: WALLET.toLowerCase(),
      agentCapitalSharePercent: 40,
      revision: 3,
      updatedAt: new Date().toISOString(),
    });

    const result = await call(CH.settings.getLighterTradingLimits, {
      environment: "rhc",
      walletAddress: WALLET,
    });

    expect(result.data).toMatchObject({ agentCapitalSharePercent: 40, revision: 3 });
  });
});

describe("settings.setLighterTradingLimits", () => {
  it("carries the caller's expected revision through to the compare-and-set write", async () => {
    mocks.writeLighterTradingLimits.mockResolvedValueOnce({
      environment: "rhc",
      walletAddress: WALLET.toLowerCase(),
      agentCapitalSharePercent: 25,
      revision: 4,
      updatedAt: new Date().toISOString(),
    });

    const result = await call(CH.settings.setLighterTradingLimits, {
      environment: "rhc",
      walletAddress: WALLET,
      agentCapitalSharePercent: 25,
      expectedRevision: 3,
    });

    expect(result.data).toMatchObject({ agentCapitalSharePercent: 25, revision: 4 });
    expect(mocks.writeLighterTradingLimits).toHaveBeenCalledWith({
      environment: "rhc",
      walletAddress: WALLET,
      agentCapitalSharePercent: 25,
      expectedRevision: 3,
    });
  });

  it("reports a revision conflict as retryable rather than overwriting the winner", async () => {
    mocks.writeLighterTradingLimits.mockRejectedValueOnce(
      new VexError(
        ErrorCodes.LIGHTER_SETTINGS_REVISION_CONFLICT,
        "These Lighter trading limits changed since they were read (now at revision 5).",
        "Reload the current value in Settings and apply the change again.",
      ),
    );

    const result = await call(CH.settings.setLighterTradingLimits, {
      environment: "rhc",
      walletAddress: WALLET,
      agentCapitalSharePercent: 25,
      expectedRevision: 3,
    });

    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain("changed since they were read");
  });

  it("refuses a share outside 1..100 at the boundary", async () => {
    const result = await call(CH.settings.setLighterTradingLimits, {
      environment: "rhc",
      walletAddress: WALLET,
      agentCapitalSharePercent: 0,
      expectedRevision: null,
    });

    expect(result.error?.code).toBe("validation.invalid_input");
    expect(mocks.writeLighterTradingLimits).not.toHaveBeenCalled();
  });

  it("refuses an unknown field the renderer tried to smuggle in", async () => {
    const result = await call(CH.settings.setLighterTradingLimits, {
      environment: "rhc",
      walletAddress: WALLET,
      agentCapitalSharePercent: 25,
      expectedRevision: null,
      accountIndex: 24226,
    });

    expect(result.error?.code).toBe("validation.invalid_input");
    expect(mocks.writeLighterTradingLimits).not.toHaveBeenCalled();
  });
});

describe("settings leverage handlers", () => {
  it("passes the selector through and returns main's own proposal", async () => {
    const proposal = {
      kind: "proposal",
      proposalId: "lighter-leverage-1",
      environment: "rhc",
      walletAddress: WALLET,
      accountIndex: 24226,
      apiKeyIndex: 4,
      marketId: 1,
      symbol: "BTC",
      current: {
        initialMarginFraction: 5000,
        leverageDisplay: "2.00",
        marginMode: "cross",
        source: "market_default",
      },
      target: { initialMarginFraction: 400, leverageDisplay: "25.00", marginMode: "cross" },
      marketMinInitialMarginFraction: 200,
      openPosition: null,
      observations: { liquidationPrice: null, openOrders: { count: 0 } },
      expiresAt: "2030-01-01T00:02:00.000Z",
    };
    mocks.prepareLighterLeverage.mockResolvedValueOnce(proposal);

    const result = await call(CH.settings.prepareLighterLeverage, {
      environment: "rhc",
      walletAddress: WALLET,
      marketId: 1,
      leverage: 25,
      marginMode: "cross",
    });

    expect(result).toEqual({ ok: true, data: proposal });
  });

  it("refuses a prepare that tries to carry its own target margin fraction", async () => {
    const result = await call(CH.settings.prepareLighterLeverage, {
      environment: "rhc",
      walletAddress: WALLET,
      marketId: 1,
      leverage: 25,
      marginMode: "cross",
      targetInitialMarginFraction: 1,
    });

    expect(result.error?.code).toBe("validation.invalid_input");
    expect(mocks.prepareLighterLeverage).not.toHaveBeenCalled();
  });

  it("surfaces a named refusal from the owner instead of a generic failure", async () => {
    mocks.prepareLighterLeverage.mockRejectedValueOnce(
      new VexError(
        ErrorCodes.LIGHTER_LEVERAGE_REFUSED,
        "BTC allows at most 50.00x leverage on Lighter.",
        "Choose a leverage at or below that maximum.",
      ),
    );

    const result = await call(CH.settings.prepareLighterLeverage, {
      environment: "rhc",
      walletAddress: WALLET,
      marketId: 1,
      leverage: 100,
      marginMode: "cross",
    });

    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain("at most 50.00x");
  });

  it("redacts an unexpected failure to a stable message with a correlation id", async () => {
    mocks.getLighterLeverageOverview.mockRejectedValueOnce(
      new Error("provider said: <a private payload>"),
    );

    const result = await call(CH.settings.getLighterLeverageOverview, {
      environment: "rhc",
      walletAddress: WALLET,
    });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("internal.unexpected");
    expect(result.error?.message).not.toContain("private payload");
  });

  it("never claims nothing was changed when an unexpected failure follows a confirm", async () => {
    // "Nothing was changed; try again" is a claim about LIGHTER. On a path that
    // can sign and submit, an unexpected failure may follow a transaction that
    // already executed, and inviting a second change would be the harm.
    mocks.confirmLighterLeverage.mockRejectedValueOnce(new Error("boom"));

    const result = await call(CH.settings.confirmLighterLeverage, {
      proposalId: "lighter-leverage-1",
    });

    expect(result.ok).toBe(false);
    expect(result.error?.message).not.toContain("Nothing was changed");
    expect(result.error?.message).toContain("Reconcile");
    expect(result.error?.retryable).toBe(false);
  });

  it("says the same for reconcile, and still says nothing changed for a read", async () => {
    mocks.reconcileLighterLeverage.mockRejectedValueOnce(new Error("boom"));
    const reconciled = await call(CH.settings.reconcileLighterLeverage, {
      proposalId: "lighter-leverage-1",
    });
    expect(reconciled.error?.message).toContain("Reconcile");

    mocks.getLighterLeverageOverview.mockRejectedValueOnce(new Error("boom"));
    const overview = await call(CH.settings.getLighterLeverageOverview, {
      environment: "rhc",
      walletAddress: WALLET,
    });
    expect(overview.error?.message).toContain("Nothing was changed");
  });

  it("accepts only a proposal id on confirm, never the terms", async () => {
    const refused = await call(CH.settings.confirmLighterLeverage, {
      proposalId: "lighter-leverage-1",
      targetInitialMarginFraction: 200,
    });
    expect(refused.error?.code).toBe("validation.invalid_input");
    expect(mocks.confirmLighterLeverage).not.toHaveBeenCalled();

    mocks.confirmLighterLeverage.mockResolvedValueOnce({
      status: "completed",
      intentId: "lighter-leverage-1",
      observed: {
        initialMarginFraction: 400,
        leverageDisplay: "25.00",
        marginMode: "cross",
        source: "position_row",
      },
    });
    const ok = await call(CH.settings.confirmLighterLeverage, {
      proposalId: "lighter-leverage-1",
    });
    expect(ok).toMatchObject({ ok: true, data: { status: "completed" } });
  });

  it("returns an ambiguous outcome as its own status, never as a failure", async () => {
    mocks.reconcileLighterLeverage.mockResolvedValueOnce({
      status: "ambiguous",
      intentId: "lighter-leverage-1",
      reason: "Vex could not confirm what Lighter did with this change.",
    });

    const result = await call(CH.settings.reconcileLighterLeverage, {
      proposalId: "lighter-leverage-1",
    });

    expect(result).toMatchObject({ ok: true, data: { status: "ambiguous" } });
  });

  it("refuses an untrusted sender before the owner is reached", async () => {
    const evil = createMainFrame("https://evil.example/index.html");
    const untrusted: TestIpcEvent = { ...sender, senderFrame: evil };

    const result = await call(
      CH.settings.confirmLighterLeverage,
      { proposalId: "lighter-leverage-1" },
      untrusted,
    );

    expect(result.ok).toBe(false);
    expect(mocks.confirmLighterLeverage).not.toHaveBeenCalled();
  });

  it("fails closed when the engine database is not ready", async () => {
    mocks.ensureEngineDbUrl.mockResolvedValueOnce({
      ok: false,
      error: { code: "internal.unexpected", domain: "settings", message: "db down" },
    });

    const result = await call(CH.settings.confirmLighterLeverage, {
      proposalId: "lighter-leverage-1",
    });

    expect(result.ok).toBe(false);
    expect(mocks.confirmLighterLeverage).not.toHaveBeenCalled();
  });
});
