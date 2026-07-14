import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createTestWebContents, createTrustedSender, type TestIpcEvent } from "./test-sender.js";

type Handler = (event: TestIpcEvent, raw: unknown) => Promise<unknown>;

const handlers = vi.hoisted(() => new Map<string, Handler>());
const mocks = vi.hoisted(() => ({
  getSessionById: vi.fn(),
  getSessionWalletScope: vi.fn(),
  meta: vi.fn(),
  metaAndAssetCtxs: vi.fn(),
  l2Book: vi.fn(),
  candleSnapshot: vi.fn(),
  getHyperliquidPositions: vi.fn(),
  listHyperliquidRiskProposals: vi.fn(),
  createAdjustedHyperliquidRiskProposal: vi.fn(),
  activateHyperliquidRiskProposal: vi.fn(),
  setSessionRiskPolicy: vi.fn(),
  getSessionRiskPolicy: vi.fn(),
  setActivePolicyOverlay: vi.fn(),
  broadcast: vi.fn(),
  preferencesLoad: vi.fn(),
  preferencesUpdate: vi.fn(),
  requestWorkspaceMode: vi.fn(),
  resolveWorkspaceMode: vi.fn(),
  hasSessionEverEntered: vi.fn(),
  getLiveFeed: vi.fn(),
  liveWatch: vi.fn(),
  liveUnwatch: vi.fn(),
  liveReleaseOwner: vi.fn(),
}));

const liveController = {
  watch: mocks.liveWatch,
  unwatch: mocks.liveUnwatch,
  releaseOwner: mocks.liveReleaseOwner,
  stop: vi.fn(),
};

vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, handler: Handler) => handlers.set(channel, handler),
    removeHandler: (channel: string) => handlers.delete(channel),
  },
}));
vi.mock("@tools/hyperliquid/info.js", () => ({
  HyperliquidInfoClient: class {
    meta = mocks.meta;
    metaAndAssetCtxs = mocks.metaAndAssetCtxs;
    l2Book = mocks.l2Book;
    candleSnapshot = mocks.candleSnapshot;
  },
}));
vi.mock("../../database/sessions-db.js", () => ({
  getSessionById: mocks.getSessionById,
  getSessionWalletScope: mocks.getSessionWalletScope,
}));
vi.mock("../../database/hyperliquid-db.js", () => ({
  getHyperliquidPositions: mocks.getHyperliquidPositions,
  listHyperliquidRiskProposals: mocks.listHyperliquidRiskProposals,
  createAdjustedHyperliquidRiskProposal: mocks.createAdjustedHyperliquidRiskProposal,
  activateHyperliquidRiskProposal: mocks.activateHyperliquidRiskProposal,
  setHyperliquidSessionRiskPolicy: mocks.setSessionRiskPolicy,
  getHyperliquidSessionRiskPolicy: mocks.getSessionRiskPolicy,
}));
vi.mock("../../preferences/store.js", () => ({
  preferencesStore: {
    load: mocks.preferencesLoad,
    update: mocks.preferencesUpdate,
  },
}));
vi.mock("../../hyperliquid/policy-provider.js", () => ({
  setActiveHyperliquidPolicyOverlay: mocks.setActivePolicyOverlay,
}));
vi.mock("../../hyperliquid/workspace-mode.js", () => ({
  hasSessionEverEnteredHypervexing: mocks.hasSessionEverEntered,
  requestHyperliquidWorkspaceMode: mocks.requestWorkspaceMode,
  resolveHyperliquidWorkspaceMode: mocks.resolveWorkspaceMode,
}));
vi.mock("../../market/hyperliquid-live-feed-service.js", () => ({
  getHyperliquidLiveFeed: mocks.getLiveFeed,
  setupHyperliquidLiveFeedService: vi.fn(),
}));
vi.mock("../../lifecycle/broadcast.js", () => ({ broadcastToAllWindows: mocks.broadcast }));
vi.mock("../../logger/index.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { registerHyperliquidHandlers } = await import("../hyperliquid.js");
const { CH } = await import("@shared/ipc/channels.js");

const SESSION_ID = "00000000-0000-4000-8000-000000000001";
const REQUEST_ID = "00000000-0000-4000-8000-000000000111";
const WATCH_ID = "00000000-0000-4000-8000-0000000000aa";
const sender = createTrustedSender({ sender: createTestWebContents() });

async function call(channel: string, payload: unknown): Promise<{ readonly ok: boolean; readonly data?: unknown; readonly error?: { readonly code: string; readonly message?: string } }> {
  const handler = handlers.get(channel);
  if (handler === undefined) throw new Error(`Missing ${channel} handler.`);
  return await handler(sender, { requestId: REQUEST_ID, payload }) as {
    readonly ok: boolean;
    readonly data?: unknown;
    readonly error?: { readonly code: string; readonly message?: string };
  };
}

beforeEach(() => {
  handlers.clear();
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-07-12T12:00:00.000Z"));
  mocks.getSessionById.mockResolvedValue({ ok: true, data: { id: SESSION_ID } });
  mocks.preferencesLoad.mockResolvedValue({ hyperliquid: { riskAcknowledgedAt: "2026-07-11T12:00:00.000Z", policy: {} } });
  mocks.getSessionWalletScope.mockResolvedValue({
    ok: true,
    data: { evm: { id: "wallet", address: "0x1111111111111111111111111111111111111111" }, solana: null },
  });
  mocks.meta.mockResolvedValue({ universe: [{ name: "BTC", maxLeverage: 50 }] });
  mocks.resolveWorkspaceMode.mockReturnValue("normal");
  mocks.hasSessionEverEntered.mockResolvedValue(true);
  mocks.requestWorkspaceMode.mockResolvedValue({
    sessionId: SESSION_ID,
    mode: "hypervexing",
    requestedBy: "agent",
    acknowledged: true,
  });
  mocks.candleSnapshot.mockResolvedValue([{ t: 1_700_000_000_000, o: "100", h: "110", l: "90", c: "105", v: "12" }]);
  mocks.getLiveFeed.mockReturnValue(liveController);
  mocks.liveWatch.mockResolvedValue(WATCH_ID);
  mocks.liveUnwatch.mockResolvedValue(true);
  mocks.liveReleaseOwner.mockResolvedValue(undefined);
  registerHyperliquidHandlers();
});

afterEach(() => {
  vi.useRealTimers();
  handlers.clear();
});

describe("Hyperliquid market-data IPC", () => {
  it("maps one metaAndAssetCtxs response into safe market rows, including positive and negative 8h funding", async () => {
    mocks.metaAndAssetCtxs.mockResolvedValueOnce([
      {
        universe: [
          { name: "BTC", maxLeverage: 50, szDecimals: 5 },
          { name: "ETH", maxLeverage: 25, szDecimals: 4 },
        ],
      },
      [
        { markPx: "105", prevDayPx: "100", openInterest: "1000", funding: "0.001", dayNtlVlm: "12345" },
        { markPx: "200", prevDayPx: "250", openInterest: "50", funding: "-0.002", dayNtlVlm: "678" },
      ],
    ]);

    const result = await call(CH.hyperliquid.getMarkets, { sessionId: SESSION_ID });

    expect(result).toEqual({
      ok: true,
      data: [
        {
          coin: "BTC",
          maxLeverage: 50,
          markPx: "105",
          change24hPct: "5",
          openInterestUsd: "105000",
          fundingRate8hPct: "0.008",
          dayNtlVlmUsd: "12345",
          szDecimals: 5,
        },
        {
          coin: "ETH",
          maxLeverage: 25,
          markPx: "200",
          change24hPct: "-20",
          openInterestUsd: "10000",
          fundingRate8hPct: "-0.016",
          dayNtlVlmUsd: "678",
          szDecimals: 4,
        },
      ],
    });
    expect(mocks.metaAndAssetCtxs).toHaveBeenCalledTimes(1);
  });

  it("returns an order-book DTO with canonical prices and sizes", async () => {
    mocks.l2Book.mockResolvedValueOnce({
      levels: [
        [{ px: "100.00", sz: "1.50", n: 2 }],
        [{ px: "101.00", sz: "2.00", n: 1 }],
      ],
      time: 1_700_000_000_000,
    });

    const result = await call(CH.hyperliquid.getBook, { sessionId: SESSION_ID, coin: "btc" });

    expect(result).toEqual({
      ok: true,
      data: {
        levels: {
          bids: [{ px: "100", sz: "1.5", n: 2 }],
          asks: [{ px: "101", sz: "2", n: 1 }],
        },
        time: 1_700_000_000_000,
      },
    });
    expect(mocks.l2Book).toHaveBeenCalledWith("BTC");
  });

  it("uses the specified short-lived main-process caches for markets and books", async () => {
    vi.advanceTimersByTime(16_000);
    mocks.metaAndAssetCtxs.mockResolvedValue([
      { universe: [{ name: "BTC", maxLeverage: 50, szDecimals: 5 }] },
      [{ markPx: "100", prevDayPx: "100", openInterest: "1", funding: "0", dayNtlVlm: "1" }],
    ]);
    mocks.l2Book.mockResolvedValue({ levels: [[], []], time: 1_700_000_000_000 });

    await call(CH.hyperliquid.getMarkets, { sessionId: SESSION_ID });
    await call(CH.hyperliquid.getMarkets, { sessionId: SESSION_ID });
    await call(CH.hyperliquid.getBook, { sessionId: SESSION_ID, coin: "ETH" });
    await call(CH.hyperliquid.getBook, { sessionId: SESSION_ID, coin: "ETH" });

    expect(mocks.metaAndAssetCtxs).toHaveBeenCalledTimes(1);
    expect(mocks.l2Book).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["1m", 6 * 60 * 60 * 1_000],
    ["5m", 24 * 60 * 60 * 1_000],
    ["15m", 3 * 24 * 60 * 60 * 1_000],
    ["1h", 7 * 24 * 60 * 60 * 1_000],
    ["4h", 30 * 24 * 60 * 60 * 1_000],
    ["1d", 180 * 24 * 60 * 60 * 1_000],
  ] as const)("uses the requested %s candle history window", async (interval, windowMs) => {
    const now = Date.now();

    const result = await call(CH.hyperliquid.getCandles, { sessionId: SESSION_ID, coin: "BTC", interval });

    expect(result.ok).toBe(true);
    expect(mocks.candleSnapshot).toHaveBeenLastCalledWith({
      coin: "BTC",
      interval,
      startTime: now - windowMs,
      endTime: now,
    });
  });

  it("reconciles workspace mode only for an existing session", async () => {
    mocks.resolveWorkspaceMode.mockReturnValueOnce("hypervexing");

    const result = await call(CH.hyperliquid.getWorkspaceMode, { sessionId: SESSION_ID });

    expect(result).toEqual({
      ok: true,
      data: { mode: "hypervexing", acknowledged: true, everEntered: true },
    });
  });

  it.each([
    [CH.hyperliquid.getCandles, { sessionId: SESSION_ID, coin: "BTC", interval: "1h" }],
    [CH.hyperliquid.getMarkets, { sessionId: SESSION_ID }],
    [CH.hyperliquid.getBook, { sessionId: SESSION_ID, coin: "BTC" }],
    [CH.hyperliquid.getWorkspaceMode, { sessionId: SESSION_ID }],
  ] as const)("fails closed when %s names a missing session", async (channel, payload) => {
    mocks.getSessionById.mockResolvedValueOnce({ ok: true, data: null });

    const result = await call(channel, payload);

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("validation.invalid_input");
    expect(mocks.metaAndAssetCtxs).not.toHaveBeenCalled();
    expect(mocks.l2Book).not.toHaveBeenCalled();
    expect(mocks.candleSnapshot).not.toHaveBeenCalled();
  });
});

describe("Hyperliquid manual workspace entry IPC", () => {
  it("rejects manual entry without the global risk acknowledgement", async () => {
    mocks.preferencesLoad.mockResolvedValueOnce({
      hyperliquid: { riskAcknowledgedAt: null, policy: {} },
    });

    const result = await call(CH.hyperliquid.enterWorkspace, { sessionId: SESSION_ID });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("validation.invalid_input");
    expect(result.error?.message).toMatch(/agent/i);
    expect(mocks.hasSessionEverEntered).not.toHaveBeenCalled();
    expect(mocks.requestWorkspaceMode).not.toHaveBeenCalled();
  });

  it("rejects manual entry when the session has never entered Hypervexing", async () => {
    mocks.hasSessionEverEntered.mockResolvedValueOnce(false);

    const result = await call(CH.hyperliquid.enterWorkspace, { sessionId: SESSION_ID });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("validation.invalid_input");
    expect(result.error?.message).toMatch(/agent/i);
    expect(mocks.requestWorkspaceMode).not.toHaveBeenCalled();
  });

  it("accepts manual re-entry when acknowledgement and prior entry are both present", async () => {
    const result = await call(CH.hyperliquid.enterWorkspace, { sessionId: SESSION_ID });

    expect(result).toEqual({ ok: true, data: { accepted: true } });
    expect(mocks.requestWorkspaceMode).toHaveBeenCalledWith(SESSION_ID, "hypervexing");
  });

  it("checks the shared session precondition before manual-entry policy", async () => {
    mocks.getSessionById.mockResolvedValueOnce({ ok: true, data: null });

    const result = await call(CH.hyperliquid.enterWorkspace, { sessionId: SESSION_ID });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("validation.invalid_input");
    expect(mocks.preferencesLoad).not.toHaveBeenCalled();
    expect(mocks.hasSessionEverEntered).not.toHaveBeenCalled();
    expect(mocks.requestWorkspaceMode).not.toHaveBeenCalled();
  });
});

describe("Hyperliquid direct session-risk policy IPC", () => {
  const policy = {
    requireStopLoss: true,
    leverageCapDefault: 3,
    perOrderNotionalPct: 20,
    totalNotionalPct: 100,
    maxSlippageEstPct: 1,
    maintenanceHeadroomFloor: 2,
    egressAlwaysApprove: true,
    marketMode: "all-core-perps" as const,
    marketAllowlist: null,
    builderFeeConsent: { kind: "none" as const },
  };
  const activeUserPolicy = {
    proposalId: "00000000-0000-4000-8000-000000000012",
    sessionId: SESSION_ID,
    coin: "ALL",
    policy,
    proposedBy: "user" as const,
    status: "active" as const,
    confirmedAt: "2026-07-12T12:00:00.000Z",
    expiresAt: null,
    createdAt: "2026-07-12T12:00:00.000Z",
  };

  it("activates a user-originated overlay and broadcasts the existing policy update event", async () => {
    mocks.setSessionRiskPolicy.mockResolvedValue({ ok: true, data: activeUserPolicy });

    const result = await call(CH.hyperliquid.setSessionRiskPolicy, {
      sessionId: SESSION_ID,
      leverageCapDefault: 3,
      perOrderNotionalPct: 20,
      totalNotionalPct: 100,
    });

    expect(result).toEqual({ ok: true, data: expect.objectContaining({ status: "active", proposedBy: "user" }) });
    expect(mocks.setSessionRiskPolicy).toHaveBeenCalledWith(SESSION_ID, {
      leverageCapDefault: 3,
      perOrderNotionalPct: 20,
      totalNotionalPct: 100,
    }, REQUEST_ID);
    expect(mocks.setActivePolicyOverlay).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: SESSION_ID,
      proposalId: activeUserPolicy.proposalId,
    }));
    expect(mocks.broadcast).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ proposalId: activeUserPolicy.proposalId }));
  });

  it("rejects values outside the session-risk contract before any policy write", async () => {
    const result = await call(CH.hyperliquid.setSessionRiskPolicy, {
      sessionId: SESSION_ID,
      leverageCapDefault: 3,
      perOrderNotionalPct: 51,
      totalNotionalPct: 100,
    });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("validation.invalid_input");
    expect(mocks.setSessionRiskPolicy).not.toHaveBeenCalled();
  });

  it("bounds the cap by the HIGHEST live max leverage (per-asset clamp handles the rest)", async () => {
    // Owner correction: a 2x micro-cap must NOT forbid a 3x session cap —
    // the protection gate clamps per order to min(cap, assetMax), so the
    // asset-agnostic bound is the universe MAXIMUM, not minimum.
    mocks.meta.mockResolvedValue({
      universe: [
        { name: "BTC", maxLeverage: 50 },
        { name: "ETH", maxLeverage: 2 },
      ],
    });

    const withinMax = await call(CH.hyperliquid.setSessionRiskPolicy, {
      sessionId: SESSION_ID,
      leverageCapDefault: 3,
      perOrderNotionalPct: 20,
      totalNotionalPct: 100,
    });
    expect(withinMax.ok).toBe(true);

    const aboveMax = await call(CH.hyperliquid.setSessionRiskPolicy, {
      sessionId: SESSION_ID,
      leverageCapDefault: 51,
      perOrderNotionalPct: 20,
      totalNotionalPct: 100,
    });
    expect(aboveMax.ok).toBe(false);
    expect(aboveMax.error?.code).toBe("validation.invalid_input");
  });

  it("fails closed for a session that has no selected EVM wallet", async () => {
    mocks.getSessionWalletScope.mockResolvedValueOnce({ ok: true, data: { evm: null, solana: null } });

    const result = await call(CH.hyperliquid.setSessionRiskPolicy, {
      sessionId: SESSION_ID,
      leverageCapDefault: 3,
      perOrderNotionalPct: 20,
      totalNotionalPct: 100,
    });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("validation.invalid_input");
    expect(mocks.setSessionRiskPolicy).not.toHaveBeenCalled();
  });

  it.each([
    ["user"],
    ["proposal"],
    ["defaults"],
  ] as const)("returns the active policy source %s", async (source) => {
    mocks.getSessionRiskPolicy.mockResolvedValueOnce({
      ok: true,
      data: { policy, source },
    });

    const result = await call(CH.hyperliquid.getSessionRiskPolicy, { sessionId: SESSION_ID });

    expect(result).toEqual({ ok: true, data: expect.objectContaining({ source }) });
    expect(mocks.getSessionRiskPolicy).toHaveBeenCalledWith(SESSION_ID, expect.anything(), REQUEST_ID);
  });
});

describe("Hyperliquid live-feed watch control IPC", () => {
  function liveSender(): {
    readonly event: TestIpcEvent;
    readonly fireDestroyed: () => void;
  } {
    const destroyedListeners: Array<() => void> = [];
    const webContents = {
      id: 55,
      send: vi.fn(),
      isDestroyed: () => false,
      once: (event: string, listener: () => void) => {
        if (event === "destroyed") destroyedListeners.push(listener);
      },
    };
    return {
      event: createTrustedSender({ sender: webContents }),
      fireDestroyed: () => {
        for (const listener of destroyedListeners) listener();
      },
    };
  }

  async function callLive(
    event: TestIpcEvent,
    channel: string,
    payload: unknown,
  ): Promise<{ readonly ok: boolean; readonly data?: unknown; readonly error?: { readonly code: string } }> {
    const handler = handlers.get(channel);
    if (handler === undefined) throw new Error(`Missing ${channel} handler.`);
    return await handler(event, { requestId: REQUEST_ID, payload }) as {
      readonly ok: boolean;
      readonly data?: unknown;
      readonly error?: { readonly code: string };
    };
  }

  it("starts a refcounted watch for an existing session and returns the watch id", async () => {
    const { event } = liveSender();

    const result = await callLive(event, CH.hyperliquid.watchLive, {
      sessionId: SESSION_ID,
      coin: "BTC",
      interval: "1h",
    });

    expect(result).toEqual({ ok: true, data: { watchId: WATCH_ID } });
    expect(mocks.liveWatch).toHaveBeenCalledWith(55, "BTC", "1h");
  });

  it("rejects watchLive for a session that no longer exists", async () => {
    mocks.getSessionById.mockResolvedValueOnce({ ok: true, data: null });
    const { event } = liveSender();

    const result = await callLive(event, CH.hyperliquid.watchLive, {
      sessionId: SESSION_ID,
      coin: "BTC",
      interval: "1h",
    });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("validation.invalid_input");
    expect(mocks.liveWatch).not.toHaveBeenCalled();
  });

  it("auto-releases every watch when the owning webContents is destroyed", async () => {
    const { event, fireDestroyed } = liveSender();

    await callLive(event, CH.hyperliquid.watchLive, {
      sessionId: SESSION_ID,
      coin: "BTC",
      interval: "1h",
    });
    expect(mocks.liveReleaseOwner).not.toHaveBeenCalled();

    fireDestroyed();
    expect(mocks.liveReleaseOwner).toHaveBeenCalledWith(55);
  });

  it("releases a watch by id through unwatchLive", async () => {
    const { event } = liveSender();

    const result = await callLive(event, CH.hyperliquid.unwatchLive, {
      sessionId: SESSION_ID,
      watchId: WATCH_ID,
    });

    expect(result).toEqual({ ok: true, data: { released: true } });
    expect(mocks.liveUnwatch).toHaveBeenCalledWith(55, WATCH_ID);
  });
});
