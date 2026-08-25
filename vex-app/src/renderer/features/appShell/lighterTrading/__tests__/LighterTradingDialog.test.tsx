import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  LighterTradingMarketList,
  LighterTradingSnapshot,
} from "@shared/schemas/lighter-trading.js";
import { LighterTradingDialog } from "../LighterTradingDialog.js";

const mocks = vi.hoisted(() => ({ onOpenChange: vi.fn(), onCreateSession: vi.fn() }));

const MARKET_LIST: LighterTradingMarketList = {
  environment: "rhc",
  retrievedAt: 1_720_000_000_000,
  markets: [
    market(1, "BTC", "perp"),
    market(7, "ETH", "perp"),
    market(8, "ETH/USDC", "spot"),
  ],
};

const SNAPSHOT: LighterTradingSnapshot = {
  environment: "rhc",
  retrievedAt: Date.now(),
  market: MARKET_LIST.markets[0]!,
  detail: {
    lastTradePrice: 3_200,
    openInterest: 42_000,
    daily: {
      tradesCount: 120,
      baseTokenVolume: 500,
      quoteTokenVolume: 1_600_000,
      priceLow: 3_100,
      priceHigh: 3_300,
      priceChange: 1.25,
    },
    funding: {
      clampSmall: "0",
      clampBig: "0",
      baseInterestRate: "0",
    },
  },
  book: {
    asks: [{ orderId: "a1", price: "3210.50", size: "4" }],
    bids: [{ orderId: "b1", price: "3199.50", size: "3" }],
  },
  trades: [],
  candles: [],
};

vi.mock("../../../../lib/api/lighter-trading.js", () => ({
  useLighterTradingMarkets: () => ({
    data: { ok: true, data: MARKET_LIST },
    isLoading: false,
  }),
  useLighterTradingSnapshot: () => ({
    data: { ok: true, data: { ...SNAPSHOT, retrievedAt: Date.now() } },
    isLoading: false,
    refetch: vi.fn(),
  }),
  useLighterTradingAccount: () => ({
    data: {
      ok: true,
      data: {
        environment: "rhc",
        retrievedAt: Date.now(),
        status: "unavailable",
        accountIndex: null,
        openOrdersAvailable: false,
        summary: null,
        assets: [],
        positions: [],
        openOrders: [],
      },
    },
    isLoading: false,
  }),
}));

vi.mock("../../../../stores/uiStore.js", () => ({
  useUiStore: (selector: (state: { theme: "chronos" }) => unknown) => selector({ theme: "chronos" }),
}));

vi.mock("../MarketChart.js", () => ({
  MarketChart: () => <div data-testid="real-chart-host" />,
}));

vi.mock("../useLighterCandleStream.js", () => ({
  useLighterCandleStream: () => ({
    candles: SNAPSHOT.candles,
    status: "live",
    providerTimestamp: SNAPSHOT.retrievedAt,
    receivedAt: SNAPSHOT.retrievedAt,
  }),
}));

vi.mock("../useLighterPublicMarketStream.js", () => ({
  useLighterPublicMarketStream: () => ({
    status: "live",
    bookStatus: "live",
    tradesStatus: "live",
    statsStatus: "live",
    book: null,
    trades: SNAPSHOT.trades,
    stats: null,
    bookReceivedAt: null,
    tradesReceivedAt: null,
    statsReceivedAt: null,
  }),
}));

vi.mock("../../SessionPanel.js", () => ({
  SessionPanel: ({ surface }: { surface?: string }) => (
    <div data-testid="active-session-chat" data-surface={surface}>
      Transcript, approvals, and composer
    </div>
  ),
}));

describe("Light it up dialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    HTMLDialogElement.prototype.showModal = function showModal(): void {
      this.setAttribute("open", "");
    };
    HTMLDialogElement.prototype.close = function close(): void {
      this.removeAttribute("open");
      this.dispatchEvent(new Event("close"));
    };
  });

  it("shows Perps and Spot while disabling unclassified Stocks", async () => {
    renderDialog();

    const perps = await screen.findByRole("button", { name: "Perps" });
    const stocks = screen.getByRole("button", { name: /Stocks/ });
    const spot = screen.getByRole("button", { name: "Spot" });

    expect(perps.getAttribute("aria-pressed")).toBe("true");
    expect((stocks as HTMLButtonElement).disabled).toBe(true);
    expect(stocks.getAttribute("title")).toBe("Provider classification unavailable");
    expect((spot as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(spot);
    await waitFor(() => expect(spot.getAttribute("aria-pressed")).toBe("true"));
  });

  it("keeps the live chart and active Vex conversation visible together", async () => {
    const view = renderDialog();

    expect(await screen.findByTestId("real-chart-host")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Chat with Vex" })).toBeTruthy();
    expect(screen.getByTestId("active-session-chat").getAttribute("data-surface")).toBe("embedded");
    expect(screen.getByText("Transcript, approvals, and composer")).toBeTruthy();

    view.rerender(
      <LighterTradingDialog
        open={false}
        activeSessionId="session-1"
        onOpenChange={mocks.onOpenChange}
        onCreateSession={mocks.onCreateSession}
      />,
    );
    expect(screen.queryByTestId("active-session-chat")).toBeNull();
  });

  it("starts on Lighter's live 5m interval and does not expose unsupported weekly streaming", async () => {
    renderDialog();

    expect(await screen.findByRole("button", { name: /BTC.*perp.*active/i })).toBeTruthy();
    expect((await screen.findByRole("button", { name: "5m" })).getAttribute("aria-pressed"))
      .toBe("true");
    expect(screen.queryByRole("button", { name: "1w" })).toBeNull();
    expect(screen.getByText("Mark")).toBeTruthy();
    expect(screen.getByText("Index")).toBeTruthy();
    expect(screen.getByText("Open interest (USD)")).toBeTruthy();
    expect(screen.getByText("Funding (current)")).toBeTruthy();
    const summary = screen.getByRole("region", { name: "Selected market summary" });
    expect(summary.getAttribute("data-market-type")).toBe("perp");
    expect(within(summary).getByText("Funding (current)").parentElement?.getAttribute("data-metric"))
      .toBe("funding");
  });

  it("uses spot-only metrics and provider percentage units", async () => {
    renderDialog();

    fireEvent.click(await screen.findByRole("button", { name: "Spot" }));
    await waitFor(() => expect(screen.getByText("24h volume (USDC)")).toBeTruthy());
    expect(screen.getByRole("region", { name: "Selected market summary" }).getAttribute("data-market-type"))
      .toBe("spot");
    expect(screen.queryByText("Open interest (USD)")).toBeNull();
    expect(screen.queryByText("Funding (current)")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /ETH\/USDC.*spot.*active/i }));
    expect(screen.getAllByText("0.0003%").length).toBeGreaterThan(0);
    expect(screen.queryByText("0.03%")).toBeNull();
  });

  it("turns the sessionless agent column into an actionable analysis start surface", async () => {
    render(
      <LighterTradingDialog
        open
        activeSessionId={null}
        onOpenChange={mocks.onOpenChange}
        onCreateSession={mocks.onCreateSession}
      />,
    );

    expect(await screen.findByText("Analyze BTC without leaving the live tape.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Read the chart/i }));
    expect(mocks.onCreateSession).toHaveBeenCalledWith(expect.stringContaining(
      "environment=rhc, marketId=1, marketType=perp, symbol=BTC, candleInterval=5m",
    ));

    fireEvent.click(screen.getByRole("button", { name: "Start a Vex session" }));
    expect(mocks.onCreateSession).toHaveBeenLastCalledWith();
  });

  it("searches and selects a real provider market from the Lighter-style picker", async () => {
    renderDialog();

    fireEvent.click(await screen.findByRole("button", { name: /BTC.*perp.*active/i }));
    const search = screen.getByRole("combobox", { name: "Search Lighter markets" });
    fireEvent.change(search, { target: { value: "USDC" } });

    const option = screen.getByRole("option", { name: /ETH\/USDC.*Spot.*active/i });
    fireEvent.click(option);

    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Search Lighter markets" })).toBeNull();
      expect(screen.getByRole("button", { name: /ETH\/USDC.*spot.*active/i })).toBeTruthy();
    });
  });

  it("opens the market picker as a corner-anchored non-modal panel", async () => {
    renderDialog();

    const trigger = await screen.findByRole("button", { name: /BTC.*perp.*active/i });
    trigger.focus();
    fireEvent.click(trigger);

    const picker = screen.getByRole("dialog", { name: "Search Lighter markets" });
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(trigger.getAttribute("aria-controls")).toBe("lit-market-picker");
    expect(picker.getAttribute("aria-modal")).toBeNull();
    expect(picker.parentElement?.classList.contains("lit-market-picker-layer")).toBe(true);
    expect(screen.getByTestId("real-chart-host")).toBeTruthy();
  });

  it("closes the corner picker when clicking elsewhere in the workspace", async () => {
    renderDialog();

    const trigger = await screen.findByRole("button", { name: /BTC.*perp.*active/i });
    trigger.focus();
    fireEvent.click(trigger);
    expect(screen.getByRole("dialog", { name: "Search Lighter markets" })).toBeTruthy();

    fireEvent.mouseDown(screen.getByTestId("real-chart-host"));

    expect(screen.queryByRole("dialog", { name: "Search Lighter markets" })).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("navigates market results from the search field and restores focus after selection", async () => {
    renderDialog();

    const trigger = await screen.findByRole("button", { name: /BTC.*perp.*active/i });
    trigger.focus();
    fireEvent.click(trigger);

    const search = screen.getByRole("combobox", { name: "Search Lighter markets" });
    fireEvent.keyDown(search, { key: "ArrowDown" });
    fireEvent.keyDown(search, { key: "Enter" });

    const selected = await screen.findByRole("button", { name: /ETH.*perp.*active/i });
    expect(screen.queryByRole("dialog", { name: "Search Lighter markets" })).toBeNull();
    expect(document.activeElement).toBe(selected);
  });

  it("closes only the market picker on Escape and does not hijack Enter on picker controls", async () => {
    renderDialog();

    const trigger = await screen.findByRole("button", { name: /BTC.*perp.*active/i });
    trigger.focus();
    fireEvent.click(trigger);

    const spotTab = within(screen.getByRole("navigation", { name: "Market type" }))
      .getByRole("button", { name: "Spot" });
    spotTab.focus();
    fireEvent.keyDown(spotTab, { key: "Enter" });
    expect(screen.getByRole("dialog", { name: "Search Lighter markets" })).toBeTruthy();
    expect(screen.getByRole("option", { name: /BTC.*Perpetual.*active/i }).getAttribute("aria-selected"))
      .toBe("true");

    fireEvent.keyDown(screen.getByRole("combobox", { name: "Search Lighter markets" }), { key: "Escape" });

    expect(screen.queryByRole("dialog", { name: "Search Lighter markets" })).toBeNull();
    expect(screen.getByRole("dialog", { name: /Light it up/i })).toBeTruthy();
    expect(document.activeElement).toBe(trigger);
  });

  it("keeps tabindex -1 market options out of the picker focus loop", async () => {
    renderDialog();

    fireEvent.click(await screen.findByRole("button", { name: /BTC.*perp.*active/i }));
    const search = screen.getByRole("combobox", { name: "Search Lighter markets" });
    search.focus();
    fireEvent.keyDown(search, { key: "Tab", shiftKey: true });

    expect(document.activeElement).toBe(
      within(screen.getByRole("navigation", { name: "Market type" }))
        .getByRole("button", { name: "Spot" }),
    );
    expect(document.activeElement?.getAttribute("role")).not.toBe("option");
  });
});

function renderDialog(): ReturnType<typeof render> {
  return render(
    <LighterTradingDialog
      open
      activeSessionId="session-1"
      onOpenChange={mocks.onOpenChange}
      onCreateSession={mocks.onCreateSession}
    />,
  );
}

function market(
  marketId: number,
  symbol: string,
  marketType: "perp" | "spot",
): LighterTradingMarketList["markets"][number] {
  return {
    marketId,
    symbol,
    marketType,
    status: "active",
    baseAssetId: 1,
    quoteAssetId: 3,
    minBaseAmount: "0.001",
    minQuoteAmount: "10",
    orderQuoteLimit: "100000",
    decimals: { size: 4, price: 2, quote: 6 },
    fees: { maker: "0", taker: "0.0003", makerEnabled: false, takerEnabled: true },
  };
}
