import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Result } from "@shared/ipc/result.js";
import type { HyperliquidPositionsDto } from "@shared/schemas/hyperliquid.js";

vi.mock("../../lifecycle/broadcast.js", () => ({ broadcastToAllWindows: vi.fn() }));
vi.mock("../../logger/index.js", () => ({
  log: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { setupHyperliquidPositionsService } = await import("../hyperliquid-positions-service.js");

const SESSION = "00000000-0000-4000-8000-000000000001";
const SESSION_TWO = "00000000-0000-4000-8000-000000000002";
const ISO = "2026-07-11T12:00:00.000Z";
const WALLET = "0x1111111111111111111111111111111111111111";

function snapshot(sessionId = SESSION): HyperliquidPositionsDto {
  return {
    sessionId,
    updatedAt: ISO,
    account: { equityUsd: "1000", withdrawableUsd: "800", totalUnrealizedPnlUsd: "5" },
    watchlist: [{ coin: "BTC", midPx: "100000", change24hPct: "1", openInterestUsd: "100000000" }],
    positions: [{
      coin: "BTC",
      side: "long",
      size: "0.01",
      entryPx: "100000",
      markPx: "100000",
      leverage: "3",
      marginMode: "isolated",
      liquidationPx: "75000",
      unrealizedPnl: "0",
      fundingAccrued: "0",
      slPrice: "98000",
      tpPrice: null,
      protectionState: "PROTECTED",
      confirmedAt: ISO,
      updatedAt: ISO,
    }],
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("setupHyperliquidPositionsService", () => {
  function scope(address = WALLET) {
    return { ok: true as const, data: { evm: { id: "wallet", address }, solana: null } };
  }

  function state(accountValue = "20") {
    return {
      marginSummary: { accountValue },
      withdrawable: accountValue,
      assetPositions: [],
    };
  }

  it("does not create an info client while neither exposure nor Hypervexing mode qualifies a session", async () => {
    const createInfoClient = vi.fn();
    const stop = setupHyperliquidPositionsService({
      hasExposure: async () => false,
      listSessionIds: async () => [SESSION],
      listHypervexingSessionIds: () => [],
      getPositions: async (): Promise<Result<HyperliquidPositionsDto>> => ({ ok: true, data: snapshot() }),
      getSessionWalletScope: async () => scope(),
      createInfoClient,
      publish: vi.fn(),
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(createInfoClient).not.toHaveBeenCalled();
    await stop();
  });

  it("publishes a main-owned mark overlay and drains cleanly on stop", async () => {
    const publish = vi.fn();
    const info = {
      allMids: vi.fn().mockResolvedValue({ BTC: "100100" }),
      clearinghouseState: vi.fn().mockResolvedValue(state("1000")),
    };
    const stop = setupHyperliquidPositionsService({
      hasExposure: async () => true,
      listSessionIds: async () => [SESSION],
      listHypervexingSessionIds: () => [],
      getPositions: async (): Promise<Result<HyperliquidPositionsDto>> => ({ ok: true, data: snapshot() }),
      getSessionWalletScope: async () => scope(),
      createInfoClient: () => info,
      publish,
      now: () => new Date(ISO),
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: SESSION,
      account: { equityUsd: "1000", withdrawableUsd: "1000", totalUnrealizedPnlUsd: "0" },
      watchlist: [{ coin: "BTC", midPx: "100100", change24hPct: "1", openInterestUsd: "100000000" }],
      positions: [expect.objectContaining({ markPx: "100100", updatedAt: ISO })],
    }));
    await stop();
  });

  it("pushes a live account with an empty positions list for a Hypervexing funded session", async () => {
    const publish = vi.fn();
    const info = {
      allMids: vi.fn().mockResolvedValue({ BTC: "100100" }),
      clearinghouseState: vi.fn().mockResolvedValue(state("20")),
    };
    const stop = setupHyperliquidPositionsService({
      hasExposure: async () => false,
      listSessionIds: async () => [],
      listHypervexingSessionIds: () => [SESSION],
      getPositions: async (): Promise<Result<HyperliquidPositionsDto>> => ({
        ok: true,
        data: { ...snapshot(), positions: [], account: { equityUsd: null, withdrawableUsd: null, totalUnrealizedPnlUsd: null } },
      }),
      getSessionWalletScope: async () => scope(),
      createInfoClient: () => info,
      publish,
      now: () => new Date(ISO),
    });

    await vi.advanceTimersByTimeAsync(0);

    expect(publish).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: SESSION,
      positions: [],
      account: { equityUsd: "20", withdrawableUsd: "20", totalUnrealizedPnlUsd: "0" },
    }));
    await stop();
  });

  it("suppresses an unchanged session snapshot", async () => {
    const publish = vi.fn();
    let nowMs = new Date(ISO).getTime();
    const info = {
      allMids: vi.fn().mockResolvedValue({ BTC: "100100" }),
      clearinghouseState: vi.fn().mockResolvedValue(state()),
    };
    const stop = setupHyperliquidPositionsService({
      hasExposure: async () => false,
      listSessionIds: async () => [],
      listHypervexingSessionIds: () => [SESSION],
      getPositions: async (): Promise<Result<HyperliquidPositionsDto>> => ({ ok: true, data: snapshot() }),
      getSessionWalletScope: async () => scope(),
      createInfoClient: () => info,
      publish,
      now: () => new Date(nowMs),
    });

    await vi.advanceTimersByTimeAsync(0);
    nowMs += 5_000;
    await vi.advanceTimersByTimeAsync(5_000);

    expect(publish).toHaveBeenCalledTimes(1);
    await stop();
  });

  it("switches the next self-scheduled tick from 15 seconds to 5 seconds when Hypervexing begins", async () => {
    let hypervexing = false;
    const info = {
      allMids: vi.fn().mockResolvedValue({ BTC: "100100" }),
      clearinghouseState: vi.fn().mockResolvedValue(state()),
    };
    const stop = setupHyperliquidPositionsService({
      hasExposure: async () => false,
      listSessionIds: async () => [],
      listHypervexingSessionIds: () => hypervexing ? [SESSION] : [],
      getPositions: async (): Promise<Result<HyperliquidPositionsDto>> => ({ ok: true, data: snapshot() }),
      getSessionWalletScope: async () => scope(),
      createInfoClient: () => info,
      publish: vi.fn(),
    });

    await vi.advanceTimersByTimeAsync(0);
    hypervexing = true;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(info.allMids).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(info.allMids).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(info.allMids).toHaveBeenCalledTimes(2);
    await stop();
  });

  it("shares one clearinghouse state read for sessions using the same wallet in a tick", async () => {
    const info = {
      allMids: vi.fn().mockResolvedValue({ BTC: "100100" }),
      clearinghouseState: vi.fn().mockResolvedValue(state()),
    };
    const stop = setupHyperliquidPositionsService({
      hasExposure: async () => true,
      listSessionIds: async () => [SESSION, SESSION_TWO],
      listHypervexingSessionIds: () => [],
      getPositions: async (sessionId): Promise<Result<HyperliquidPositionsDto>> => ({ ok: true, data: snapshot(sessionId) }),
      getSessionWalletScope: async () => scope(),
      createInfoClient: () => info,
      publish: vi.fn(),
    });

    await vi.advanceTimersByTimeAsync(0);

    expect(info.clearinghouseState).toHaveBeenCalledTimes(1);
    expect(info.clearinghouseState).toHaveBeenCalledWith(WALLET);
    await stop();
  });
});
