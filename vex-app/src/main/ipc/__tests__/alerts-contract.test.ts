/**
 * The F01 contract: what the engine's alert service and bus actually produce
 * parses with the shared DTO schemas the IPC channels and the page use. A
 * field added on one side and not the other fails here, not in the app.
 */

import { describe, expect, it } from "vitest";

import {
  acknowledgeFiredResultSchema,
  alertRefusalSchema,
  cancelPriceAlertResultSchema,
  editWatchlistResultSchema,
  priceAlertFiredEventSchema,
  setPriceAlertResultSchema,
  watchlistSnapshotSchema,
} from "@shared/schemas/alerts.js";
import {
  acknowledgeFired,
  addToWatchlist,
  cancelPriceAlert,
  readWatchlist,
  setPriceAlert,
  type AlertServiceDeps,
} from "@vex-agent/alerts/service.js";
import { onPriceAlertFired, emitPriceAlertFired, type PriceAlertFiredEvent } from "@vex-agent/alerts/price-alert-bus.js";
import type { PriceAlertRow, WatchlistItemRow } from "@vex-agent/db/repos/price-alerts.js";

const WETH = "0x4200000000000000000000000000000000000006";
const KEY = `base:${WETH}`;
const NOW = new Date("2026-10-24T12:00:00.000Z");

function deps(): AlertServiceDeps {
  const watchlist: WatchlistItemRow[] = [];
  const alerts: PriceAlertRow[] = [];
  return {
    now: () => NOW,
    priceTokens: async () => ({
      quotes: new Map([
        [KEY, {
          assetKey: KEY,
          priceUsd: "3500.25",
          price: { units: 350025n, scale: 2 },
          change24hPct: -1.25,
          pairAddress: "0xpool",
          dexId: "uniswap",
          symbol: "WETH",
        }],
      ]),
      failed: [],
    }),
    repo: {
      listWatchlist: async () => [...watchlist],
      addWatchlistItem: async (input) => {
        const item = { id: "w1", createdAt: NOW.toISOString(), ...input };
        watchlist.push(item);
        return { ok: true, item, created: true };
      },
      removeWatchlistItem: async () => true,
      listAlerts: async ({ status }) => alerts.filter((a) => a.status === status),
      createAlert: async (input) => {
        const alert: PriceAlertRow = {
          ...input,
          id: "6f1c2a4e-8b3d-4c5e-9f10-1a2b3c4d5e6f",
          status: "active",
          triggeredAt: null,
          triggeredPrice: null,
          acknowledgedAt: null,
          createdAt: NOW.toISOString(),
        };
        alerts.push(alert);
        return { ok: true, alert, created: true };
      },
      cancelAlert: async (id) => {
        const found = alerts.find((a) => a.id === id);
        return found === undefined ? null : { ...found, status: "cancelled" };
      },
      acknowledgeFired: async (ids) => ids.length,
      clearFired: async (ids) => ids.length,
    },
  };
}

describe("F01 contract: engine output parses with the shared schemas", () => {
  it("setPriceAlert, a refusal, cancel and the snapshot", async () => {
    const d = deps();
    const set = await setPriceAlert(
      { chain: "base", tokenAddress: WETH, condition: "rises_pct", value: "10", note: "breakout", origin: "app" },
      d,
    );
    expect(setPriceAlertResultSchema.safeParse(set).success).toBe(true);

    const refused = await setPriceAlert(
      { chain: "base", tokenAddress: WETH, condition: "above", value: "3000", origin: "app" },
      d,
    );
    expect(alertRefusalSchema.safeParse(refused).success).toBe(true);

    if (!set.ok) throw new Error("expected an alert");
    const cancelled = await cancelPriceAlert({ alertId: set.alert.id }, d);
    expect(cancelPriceAlertResultSchema.safeParse(cancelled).success).toBe(true);

    const added = await addToWatchlist({ chain: "base", tokenAddress: WETH }, d);
    expect(editWatchlistResultSchema.safeParse(added.ok ? { ...added, action: "add" } : added).success).toBe(true);

    const snapshot = await readWatchlist({}, d);
    const parsed = watchlistSnapshotSchema.safeParse(snapshot);
    expect(parsed.success).toBe(true);
    expect(snapshot.items[0]?.quote?.priceUsd).toBe("3500.25");
  });

  it("acknowledgeFired", async () => {
    const result = await acknowledgeFired({ alertIds: ["6f1c2a4e-8b3d-4c5e-9f10-1a2b3c4d5e6f"], clear: false }, deps());
    expect(acknowledgeFiredResultSchema.safeParse(result).success).toBe(true);
  });

  it("the fired event", () => {
    const seen: PriceAlertFiredEvent[] = [];
    const off = onPriceAlertFired((event) => seen.push(event));
    emitPriceAlertFired({
      alertId: "6f1c2a4e-8b3d-4c5e-9f10-1a2b3c4d5e6f",
      assetKey: KEY,
      chain: "base",
      label: "WETH",
      condition: "rises_pct",
      value: "10",
      direction: "above",
      triggerPrice: "3850.275",
      triggeredPrice: "3851",
      triggeredAt: NOW.toISOString(),
      note: null,
    });
    off();
    expect(seen).toHaveLength(1);
    expect(priceAlertFiredEventSchema.safeParse(seen[0]).success).toBe(true);
  });
});
