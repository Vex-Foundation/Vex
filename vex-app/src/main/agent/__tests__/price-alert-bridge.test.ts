/**
 * `price-alert-bridge` (F01): a fired alert reaches every window, and an OS
 * notification only when no window is focused (the helper's own check), the
 * user has not turned them off, with a generic body while the vault is
 * locked. Driven through the REAL bus emitter.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../logger/index.js", () => ({
  log: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { EV } from "@shared/ipc/channels.js";
import { LOCKED_PRICE_ALERT_BODY, PRICE_ALERT_TITLE } from "@shared/alerts-copy.js";
import { emitPriceAlertFired, onPriceAlertFired } from "@vex-agent/alerts/price-alert-bus.js";
import {
  openWatchlistWindow,
  setupPriceAlertBridge,
  type PriceAlertBridgeDeps,
  type WatchlistWindow,
} from "../price-alert-bridge.js";

const WETH = "0x4200000000000000000000000000000000000006";
const FIRED = {
  alertId: "6f1c2a4e-8b3d-4c5e-9f10-1a2b3c4d5e6f",
  assetKey: `base:${WETH}`,
  chain: "base",
  label: "WETH",
  condition: "above",
  value: "4000",
  direction: "above",
  triggerPrice: "4000",
  triggeredPrice: "4012.5",
  triggeredAt: "2026-10-24T12:00:00.000Z",
  note: "take profit",
} as const;

function fakeWindow(minimized = false): WatchlistWindow & { readonly sent: string[]; readonly calls: string[] } {
  const sent: string[] = [];
  const calls: string[] = [];
  return {
    sent,
    calls,
    isMinimized: () => minimized,
    restore: () => calls.push("restore"),
    show: () => calls.push("show"),
    focus: () => calls.push("focus"),
    isDestroyed: () => false,
    webContents: { send: (channel: string) => sent.push(channel) },
  };
}

function deps(over: Partial<PriceAlertBridgeDeps> = {}) {
  const broadcast = vi.fn();
  const showNotice = vi.fn(() => true);
  const base: PriceAlertBridgeDeps = {
    subscribe: onPriceAlertFired,
    broadcast,
    showNotice,
    osNoticesEnabled: async () => true,
    isUnlocked: () => true,
    getWindow: () => null,
    createWindow: async () => fakeWindow(),
  };
  return { deps: { ...base, ...over }, broadcast, showNotice };
}

/** Let the bridge's async delivery settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

let teardown: (() => void) | null = null;

beforeEach(() => {
  teardown?.();
  teardown = null;
});

describe("price alert bridge", () => {
  it("broadcasts the validated event and shows the full sentence while unlocked", async () => {
    const { deps: d, broadcast, showNotice } = deps();
    teardown = setupPriceAlertBridge(d);
    emitPriceAlertFired(FIRED);
    await settle();
    expect(broadcast).toHaveBeenCalledWith(EV.alerts.priceAlertFired, {
      type: "engine.alerts.price_alert_fired",
      ...FIRED,
    });
    expect(showNotice).toHaveBeenCalledWith(
      expect.objectContaining({
        title: PRICE_ALERT_TITLE,
        body: "WETH on Base went above $4000, at $4012.5. Note: take profit",
      }),
    );
  });

  it("hides the token and price while the vault is locked", async () => {
    const { deps: d, showNotice } = deps({ isUnlocked: () => false });
    teardown = setupPriceAlertBridge(d);
    emitPriceAlertFired(FIRED);
    await settle();
    expect(showNotice).toHaveBeenCalledWith(expect.objectContaining({ body: LOCKED_PRICE_ALERT_BODY }));
  });

  it("shows no OS notification when the user turned them off, but still broadcasts", async () => {
    const { deps: d, broadcast, showNotice } = deps({ osNoticesEnabled: async () => false });
    teardown = setupPriceAlertBridge(d);
    emitPriceAlertFired(FIRED);
    await settle();
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(showNotice).not.toHaveBeenCalled();
  });

  it("drops an event that does not match the shared contract", async () => {
    const { deps: d, broadcast } = deps();
    teardown = setupPriceAlertBridge(d);
    emitPriceAlertFired({ ...FIRED, triggeredPrice: "not a price" });
    await settle();
    expect(broadcast).not.toHaveBeenCalled();
  });

  it("stops listening after teardown", async () => {
    const { deps: d, broadcast } = deps();
    setupPriceAlertBridge(d)();
    emitPriceAlertFired(FIRED);
    await settle();
    expect(broadcast).not.toHaveBeenCalled();
  });
});

describe("openWatchlistWindow", () => {
  it("restores and focuses the existing window, then routes to the watchlist", async () => {
    const win = fakeWindow(true);
    const { deps: d } = deps({ getWindow: () => win });
    await openWatchlistWindow(d);
    expect(win.calls).toEqual(["restore", "show", "focus"]);
    expect(win.sent).toEqual([EV.alerts.openWatchlist]);
  });

  it("recreates a closed window and routes it", async () => {
    vi.useFakeTimers();
    const win = fakeWindow();
    const { deps: d } = deps({ getWindow: () => null, createWindow: async () => win });
    await openWatchlistWindow(d);
    expect(win.sent).toEqual([EV.alerts.openWatchlist]);
    vi.advanceTimersByTime(1_000);
    expect(win.sent).toEqual([EV.alerts.openWatchlist, EV.alerts.openWatchlist]);
    vi.useRealTimers();
  });
});
