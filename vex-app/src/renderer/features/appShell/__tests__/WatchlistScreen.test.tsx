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
const PASTED = "0x0000000000000000000000000000000000000001";
const BRETT_HIT = {
  address: "0x532f27101965dd16442E59d40670FaF5eBB142E4",
  symbol: "BRETT",
  name: "Brett",
  priceUsd: "0.004663",
  liquidityUsd: 2_100_000,
  volume24hUsd: 222_297,
  poolCount: 14,
  dexId: "aerodrome",
  pairAddress: "0xpool1",
};
const COPYCAT_HIT = { ...BRETT_HIT, address: "0x9999999999999999999999999999999999999999", volume24hUsd: 3, poolCount: 1 };
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
  searchTokens: vi.fn(),
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
    fireEvent.change(field, { target: { value: PASTED } });
    fireEvent.click(screen.getByRole("button", { name: "Follow" }));
    expect((await screen.findByTestId("watchlist-add-refusal")).textContent).toBe("That is not a Base token address.");
    expect(alerts.editWatchlist).toHaveBeenCalledWith({ action: "add", chain: "base", tokenAddress: PASTED });
    // A pasted address is followed as it is: nothing is searched.
    expect(alerts.searchTokens).not.toHaveBeenCalled();
  });

  it("searches a typed ticker on the chosen chain and follows the picked token by its address", async () => {
    alerts.searchTokens.mockResolvedValue({
      ok: true,
      data: { ok: true, chain: "base", query: "BRETT", source: "chain_search", tokens: [BRETT_HIT, COPYCAT_HIT] },
    });
    alerts.editWatchlist.mockResolvedValue({ ok: true, data: { ok: true, action: "add", item: SNAPSHOT.items[0], created: true } });
    renderPage();
    const field = await screen.findByTestId("watchlist-add-address");
    fireEvent.focus(field);
    fireEvent.change(field, { target: { value: "BRETT" } });
    // A ticker alone is not an address: Follow waits for a pick.
    expect(screen.getByRole("button", { name: "Follow" })).toHaveProperty("disabled", true);
    const options = await screen.findAllByTestId("watchlist-token-option");
    expect(alerts.searchTokens).toHaveBeenCalledWith({ chain: "base", query: "BRETT" });
    expect(options).toHaveLength(2);
    expect(options[0]?.textContent).toContain("0x532f…42E4");
    expect(options[0]?.textContent).toContain("$222k 24h volume · 14 pools");
    fireEvent.keyDown(field, { key: "Enter" });
    expect(screen.getByTestId("watchlist-add-picked").textContent).toContain("BRETT on Base");
    fireEvent.click(screen.getByRole("button", { name: "Follow" }));
    await waitFor(() =>
      expect(alerts.editWatchlist).toHaveBeenCalledWith({
        action: "add",
        chain: "base",
        tokenAddress: BRETT_HIT.address,
        label: "BRETT",
      }),
    );
  });

  it("says so when nothing on the chain matches", async () => {
    alerts.searchTokens.mockResolvedValue({
      ok: true,
      data: { ok: true, chain: "base", query: "ZZZQ", source: "chain_search", tokens: [] },
    });
    renderPage();
    const field = await screen.findByTestId("watchlist-add-address");
    fireEvent.focus(field);
    fireEvent.change(field, { target: { value: "ZZZQ" } });
    await waitFor(() =>
      expect(screen.getByTestId("watchlist-token-status").textContent).toBe(
        'No Base token matches "ZZZQ". Paste its address instead.',
      ),
    );
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
