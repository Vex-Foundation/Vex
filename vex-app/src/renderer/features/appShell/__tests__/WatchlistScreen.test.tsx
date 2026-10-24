/**
 * The Watchlist page (F01): rows with price and change, a refusal shown by
 * name, setting an alert from a row, cancelling, and clearing fired ones.
 * `window.vex.alerts` is a fake; the real engine is covered by its own tests.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { PriceAlertDto, WatchlistSnapshotDto } from "@shared/schemas/alerts.js";
import { WatchlistPage } from "../screens/WatchlistScreen.js";

const WETH = "0x4200000000000000000000000000000000000006";
const NOW = "2026-10-24T12:00:00.000Z";
const ACTIVE_ID = "6f1c2a4e-8b3d-4c5e-9f10-1a2b3c4d5e6f";
const FIRED_ID = "7a2d3b5f-9c4e-4d6f-8a21-2b3c4d5e6f70";

function alert(over: Partial<PriceAlertDto>): PriceAlertDto {
  return {
    id: ACTIVE_ID,
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
    origin: "chat",
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
  activeAlerts: [alert({})],
  firedAlerts: [
    alert({
      id: FIRED_ID,
      condition: "falls_pct",
      value: "5",
      status: "triggered",
      triggeredAt: NOW,
      triggeredPrice: "3325.2",
    }),
  ],
  limits: { watchlist: 30, activeAlerts: 20 },
  pricedAt: NOW,
};

const alerts = {
  getWatchlist: vi.fn(),
  editWatchlist: vi.fn(),
  setPriceAlert: vi.fn(),
  cancelPriceAlert: vi.fn(),
  acknowledgeFired: vi.fn(),
  onPriceAlertFired: vi.fn(() => () => undefined),
  onOpenWatchlist: vi.fn(() => () => undefined),
};

function renderPage(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <WatchlistPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  for (const fn of Object.values(alerts)) fn.mockReset();
  alerts.getWatchlist.mockResolvedValue({ ok: true, data: SNAPSHOT });
  Object.defineProperty(window, "vex", { value: { alerts }, configurable: true, writable: true });
});

afterEach(() => {
  cleanup();
});

describe("WatchlistPage", () => {
  it("lists the followed token with its price, change and pool", async () => {
    renderPage();
    expect(await screen.findByText("$3500.25")).toBeTruthy();
    expect(screen.getByTestId("watchlist-change").textContent).toBe("-1.25%");
    expect(screen.getByText("Base · uniswap")).toBeTruthy();
    expect(screen.getByTestId("watchlist-counts").textContent).toContain("1 of 30");
  });

  it("shows a refusal by name when following fails", async () => {
    alerts.editWatchlist.mockResolvedValue({
      ok: true,
      data: { ok: false, reason: "invalid_address", message: "That is not a Base token address." },
    });
    renderPage();
    const field = await screen.findByTestId("watchlist-add-address");
    fireEvent.change(field, { target: { value: "0xnope" } });
    fireEvent.click(screen.getByRole("button", { name: "Follow" }));
    expect((await screen.findByTestId("watchlist-add-refusal")).textContent).toBe("That is not a Base token address.");
    expect(alerts.editWatchlist).toHaveBeenCalledWith({ action: "add", chain: "base", tokenAddress: "0xnope" });
  });

  it("sets an alert from a row with the token's identity", async () => {
    alerts.setPriceAlert.mockResolvedValue({ ok: true, data: { ok: true, status: "created", alert: alert({}), priceUsd: "3500.25" } });
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Set alert" }));
    fireEvent.change(screen.getByTestId("watchlist-alert-value"), { target: { value: "4200" } });
    fireEvent.click(within(screen.getByTestId("watchlist-alert-form")).getByRole("button", { name: "Set alert" }));
    await waitFor(() => expect(alerts.setPriceAlert).toHaveBeenCalled());
    expect(alerts.setPriceAlert).toHaveBeenCalledWith({
      chain: "base",
      tokenAddress: WETH,
      condition: "above",
      value: "4200",
      label: "WETH",
    });
  });

  it("names where an active alert came from and cancels it", async () => {
    alerts.cancelPriceAlert.mockResolvedValue({ ok: true, data: { ok: true, alert: alert({ status: "cancelled" }) } });
    renderPage();
    const row = await screen.findByTestId("watchlist-active-row");
    expect(row.textContent).toContain("WETH on Base, above $4000");
    expect(row.textContent).toContain("Set from chat");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(alerts.cancelPriceAlert).toHaveBeenCalledWith({ alertId: ACTIVE_ID }));
  });

  it("shows a fired alert with its sentence and clears it", async () => {
    alerts.acknowledgeFired.mockResolvedValue({ ok: true, data: { ok: true, acknowledged: 1, cleared: 1 } });
    renderPage();
    const row = await screen.findByTestId("watchlist-fired-row");
    expect(row.textContent).toContain("WETH on Base fell 5%, at $3325.2.");
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    await waitFor(() => expect(alerts.acknowledgeFired).toHaveBeenCalledWith({ alertIds: [FIRED_ID], clear: true }));
  });

  it("says what an alert is not", async () => {
    renderPage();
    expect((await screen.findByTestId("watchlist-footnote")).textContent).toContain("it never trades");
  });
});
