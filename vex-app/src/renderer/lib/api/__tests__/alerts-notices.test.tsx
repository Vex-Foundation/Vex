/**
 * `usePriceAlertNotices` (F01): unacknowledged fired alerts are shown once on
 * mount, a pushed alert raises its notice, and a user close acknowledges it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { JSX } from "react";
import type { PriceAlertDto, PriceAlertFiredEventDto } from "@shared/schemas/alerts.js";
import { notifications } from "../../notifications/index.js";
import { usePriceAlertNotices } from "../alerts.js";

const WETH = "0x4200000000000000000000000000000000000006";
const NOW = "2026-10-24T12:00:00.000Z";
const UNACKED = "6f1c2a4e-8b3d-4c5e-9f10-1a2b3c4d5e6f";
const ACKED = "7a2d3b5f-9c4e-4d6f-8a21-2b3c4d5e6f70";
const PUSHED = "8b3e4c60-ad5f-4e70-9b32-3c4d5e6f7081";

function fired(id: string, acknowledgedAt: string | null): PriceAlertDto {
  return {
    id,
    chain: "base",
    address: WETH,
    assetKey: `base:${WETH}`,
    label: "WETH",
    condition: "above",
    value: "4000",
    referencePrice: "3500",
    triggerPrice: "4000",
    direction: "above",
    note: null,
    origin: "app",
    sessionId: null,
    status: "triggered",
    triggeredAt: NOW,
    triggeredPrice: "4012.5",
    acknowledgedAt,
    createdAt: NOW,
  };
}

let pushed: ((event: PriceAlertFiredEventDto) => void) | null = null;
const alerts = {
  getWatchlist: vi.fn(),
  acknowledgeFired: vi.fn(async () => ({ ok: true, data: { ok: true, acknowledged: 1, cleared: 0 } })),
  onPriceAlertFired: vi.fn((cb: (event: PriceAlertFiredEventDto) => void) => {
    pushed = cb;
    return () => {
      pushed = null;
    };
  }),
  onOpenWatchlist: vi.fn(() => () => undefined),
};

function Host(): JSX.Element {
  usePriceAlertNotices();
  return <div />;
}

function mount(): void {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <Host />
    </QueryClientProvider>,
  );
}

function priceNotices() {
  return notifications.getSnapshot().items.filter((n) => n.source === "alerts.price");
}

beforeEach(() => {
  notifications.reset();
  alerts.getWatchlist.mockReset();
  alerts.acknowledgeFired.mockClear();
  alerts.getWatchlist.mockResolvedValue({
    ok: true,
    data: {
      items: [],
      activeAlerts: [],
      firedAlerts: [fired(UNACKED, null), fired(ACKED, NOW)],
      limits: { watchlist: 30, activeAlerts: 20 },
      pricedAt: NOW,
    },
  });
  Object.defineProperty(window, "vex", { value: { alerts }, configurable: true, writable: true });
});

afterEach(() => {
  cleanup();
});

describe("usePriceAlertNotices", () => {
  it("replays only the unacknowledged fired alerts on mount", async () => {
    mount();
    await waitFor(() => expect(priceNotices()).toHaveLength(1));
    expect(priceNotices()[0]?.message).toBe("WETH on Base went above $4000, at $4012.5.");
    expect(priceNotices()[0]?.actions.map((a) => a.label)).toEqual(["Open watchlist"]);
  });

  it("raises a pushed alert and acknowledges it when the user closes it", async () => {
    mount();
    await waitFor(() => expect(pushed).not.toBeNull());
    pushed?.({
      type: "engine.alerts.price_alert_fired",
      alertId: PUSHED,
      assetKey: `base:${WETH}`,
      chain: "base",
      label: "WETH",
      condition: "rises_pct",
      value: "5",
      direction: "above",
      triggerPrice: "3675",
      triggeredPrice: "3680",
      triggeredAt: NOW,
      note: null,
    });
    const notice = priceNotices().find((n) => n.message.startsWith("WETH on Base rose 5%"));
    expect(notice).toBeDefined();
    if (notice === undefined) return;
    notifications.close(notice.id, "user");
    await waitFor(() => expect(alerts.acknowledgeFired).toHaveBeenCalledWith({ alertIds: [PUSHED], clear: false }));
  });
});
