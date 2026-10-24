/**
 * vex.alerts.* handlers (F01): each waits for the engine database, calls the
 * one engine service, returns a refusal as a VALUE, and maps a failure to
 * reach the database to `internal.unexpected` in the `alerts` domain.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PriceAlertDto, WatchlistSnapshotDto } from "@shared/schemas/alerts.js";
import { createTestWebContents, createTrustedSender, type TestIpcEvent } from "./test-sender.js";

type Handler = (event: TestIpcEvent, raw: unknown) => Promise<unknown>;
const handlers = vi.hoisted(() => new Map<string, Handler>());
const mocks = vi.hoisted(() => ({
  whenEngineDbReady: vi.fn(),
  readWatchlist: vi.fn(),
  addToWatchlist: vi.fn(),
  removeFromWatchlist: vi.fn(),
  setPriceAlert: vi.fn(),
  cancelPriceAlert: vi.fn(),
  acknowledgeFired: vi.fn(),
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
  whenEngineDbReady: (...args: unknown[]) => mocks.whenEngineDbReady(...args),
}));
vi.mock("@vex-agent/alerts/service.js", () => ({
  readWatchlist: (...args: unknown[]) => mocks.readWatchlist(...args),
  addToWatchlist: (...args: unknown[]) => mocks.addToWatchlist(...args),
  removeFromWatchlist: (...args: unknown[]) => mocks.removeFromWatchlist(...args),
  setPriceAlert: (...args: unknown[]) => mocks.setPriceAlert(...args),
  cancelPriceAlert: (...args: unknown[]) => mocks.cancelPriceAlert(...args),
  acknowledgeFired: (...args: unknown[]) => mocks.acknowledgeFired(...args),
}));

const { registerAlertsHandlers } = await import("../alerts.js");
const { CH } = await import("@shared/ipc/channels.js");

const sender = createTrustedSender({ sender: createTestWebContents() });
const REQUEST_ID = "00000000-0000-4000-8000-000000000f01";
const WETH = "0x4200000000000000000000000000000000000006";
const ALERT_ID = "6f1c2a4e-8b3d-4c5e-9f10-1a2b3c4d5e6f";
const NOW = "2026-10-24T12:00:00.000Z";

type CallResult = {
  readonly ok: boolean;
  readonly data?: unknown;
  readonly error?: { readonly code: string; readonly domain: string };
};

async function call(channel: string, payload: unknown): Promise<CallResult> {
  const handler = handlers.get(channel);
  if (handler === undefined) throw new Error(`Handler not registered: ${channel}`);
  return (await handler(sender, { requestId: REQUEST_ID, payload })) as CallResult;
}

function alertDto(over: Partial<PriceAlertDto> = {}): PriceAlertDto {
  return {
    id: ALERT_ID,
    chain: "base",
    address: WETH,
    assetKey: `base:${WETH}`,
    label: "WETH",
    condition: "above",
    value: "4000",
    referencePrice: "3500.25",
    triggerPrice: "4000",
    direction: "above",
    note: null,
    origin: "app",
    sessionId: null,
    status: "active",
    triggeredAt: null,
    triggeredPrice: null,
    acknowledgedAt: null,
    createdAt: NOW,
    ...over,
  };
}

const SNAPSHOT: WatchlistSnapshotDto = {
  items: [
    {
      assetKey: `base:${WETH}`,
      chain: "base",
      address: WETH,
      label: "WETH",
      createdAt: NOW,
      quote: { priceUsd: "3500.25", change24hPct: -1.25, pairAddress: "0xpool", dexId: "uniswap" },
      priceStatus: "priced",
    },
  ],
  activeAlerts: [alertDto()],
  firedAlerts: [],
  limits: { watchlist: 30, activeAlerts: 20 },
  pricedAt: NOW,
};

beforeEach(() => {
  handlers.clear();
  for (const fn of Object.values(mocks)) fn.mockReset();
  mocks.whenEngineDbReady.mockResolvedValue(undefined);
  registerAlertsHandlers();
});

describe("vex.alerts handlers", () => {
  it("reads the watchlist after the engine database is ready", async () => {
    mocks.readWatchlist.mockResolvedValue(SNAPSHOT);
    const result = await call(CH.alerts.getWatchlist, {});
    expect(result).toEqual({ ok: true, data: SNAPSHOT });
    expect(mocks.whenEngineDbReady).toHaveBeenCalledTimes(1);
  });

  it("adds a token and names the action in the result", async () => {
    mocks.addToWatchlist.mockResolvedValue({ ok: true, item: SNAPSHOT.items[0], created: true });
    const result = await call(CH.alerts.editWatchlist, { action: "add", chain: "base", tokenAddress: WETH });
    expect(result).toEqual({ ok: true, data: { ok: true, action: "add", item: SNAPSHOT.items[0], created: true } });
    expect(mocks.addToWatchlist).toHaveBeenCalledWith({ chain: "base", tokenAddress: WETH });
  });

  it("removes a token by asset key", async () => {
    mocks.removeFromWatchlist.mockResolvedValue({ ok: true, assetKey: `base:${WETH}` });
    const result = await call(CH.alerts.editWatchlist, { action: "remove", assetKey: `base:${WETH}` });
    expect(result).toEqual({ ok: true, data: { ok: true, action: "remove", assetKey: `base:${WETH}` } });
  });

  it("returns a refusal as a value, not an IPC error", async () => {
    const refusal = { ok: false, reason: "unsupported_chain", message: "Vex cannot price tokens on that chain." };
    mocks.addToWatchlist.mockResolvedValue(refusal);
    const result = await call(CH.alerts.editWatchlist, { action: "add", chain: "nowhere", tokenAddress: WETH });
    expect(result).toEqual({ ok: true, data: refusal });
  });

  it("sets an alert from the page with the app origin and no session", async () => {
    mocks.setPriceAlert.mockResolvedValue({ ok: true, status: "created", alert: alertDto(), priceUsd: "3500.25" });
    const result = await call(CH.alerts.setPriceAlert, {
      chain: "base",
      tokenAddress: WETH,
      condition: "above",
      value: "4000",
      note: "take profit",
    });
    expect(result.ok).toBe(true);
    expect(mocks.setPriceAlert).toHaveBeenCalledWith({
      chain: "base",
      tokenAddress: WETH,
      condition: "above",
      value: "4000",
      note: "take profit",
      origin: "app",
    });
  });

  it("cancels an alert and acknowledges fired ones", async () => {
    mocks.cancelPriceAlert.mockResolvedValue({ ok: true, alert: alertDto({ status: "cancelled" }) });
    expect((await call(CH.alerts.cancelPriceAlert, { alertId: ALERT_ID })).ok).toBe(true);
    expect(mocks.cancelPriceAlert).toHaveBeenCalledWith({ alertId: ALERT_ID });

    mocks.acknowledgeFired.mockResolvedValue({ ok: true, acknowledged: 1, cleared: 1 });
    const ack = await call(CH.alerts.acknowledgeFired, { alertIds: [ALERT_ID], clear: true });
    expect(ack).toEqual({ ok: true, data: { ok: true, acknowledged: 1, cleared: 1 } });
  });

  it("maps a database that cannot be reached to internal.unexpected in the alerts domain", async () => {
    mocks.whenEngineDbReady.mockRejectedValue(new Error("database down"));
    const result = await call(CH.alerts.getWatchlist, {});
    expect(result.ok).toBe(false);
    expect(result.error).toMatchObject({ code: "internal.unexpected", domain: "alerts" });
    expect(mocks.readWatchlist).not.toHaveBeenCalled();
  });

  it("refuses a malformed input before the service runs", async () => {
    const result = await call(CH.alerts.cancelPriceAlert, { alertId: "not-a-uuid" });
    expect(result.ok).toBe(false);
    expect(mocks.cancelPriceAlert).not.toHaveBeenCalled();
  });
});
