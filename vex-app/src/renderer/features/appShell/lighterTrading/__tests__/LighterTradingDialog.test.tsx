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
    market(0, "ETH", "perp"),
    market(2048, "ETH/USDG", "spot", 1, 3),
    market(2065, "SPY/USDG", "spot", 20, 3, 2_054, 1_425_995.03),
    market(10, "AAPL", "perp"),
    market(2049, "AAPL/USDG", "spot", 4, 3),
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

  it("partitions provider markets into enabled Perps, Stocks, and Spot sections", async () => {
    renderDialog();

    const perps = await screen.findByRole("button", { name: "Perps" });
    const stocks = screen.getByRole("button", { name: /Stocks/ });
    const spot = screen.getByRole("button", { name: "Spot" });

    expect(perps.getAttribute("aria-pressed")).toBe("true");
    expect((stocks as HTMLButtonElement).disabled).toBe(false);
    expect((spot as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(stocks);
    await waitFor(() => expect(stocks.getAttribute("aria-pressed")).toBe("true"));
    const summary = screen.getByRole("region", { name: "Selected market summary" });
    expect(summary.getAttribute("data-market-section")).toBe("stocks");
    expect(summary.getAttribute("data-market-type")).toBe("perp");
    expect(within(summary).getByText("Stock · Perpetual", { exact: false })).toBeTruthy();
  });

  it("keeps a tokenized equity under Stocks while preserving its spot execution", async () => {
    renderDialog();

    fireEvent.click(await screen.findByRole("button", { name: /BTC.*Perpetual.*active/i }));
    const pickerTabs = within(screen.getByRole("navigation", { name: "Market type" }));
    fireEvent.click(pickerTabs.getByRole("button", { name: "Stocks" }));

    expect(screen.queryByRole("option", { name: /BTC/ })).toBeNull();
    const stockSpot = screen.getByRole("option", {
      name: /AAPL\/USDG.*Stock token.*Spot.*active/i,
    });
    fireEvent.click(stockSpot);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Stocks" }).getAttribute("aria-pressed"))
        .toBe("true");
    });
    const summary = screen.getByRole("region", { name: "Selected market summary" });
    expect(summary.getAttribute("data-market-section")).toBe("stocks");
    expect(summary.getAttribute("data-market-type")).toBe("spot");
    expect(within(summary).getByText("AAPL")).toBeTruthy();
    expect(within(summary).getByText(/AAPL\/USDG.*Stock token.*Spot.*active/i)).toBeTruthy();
    expect(screen.getByText("24h volume (USDG)")).toBeTruthy();
    expect(screen.queryByText("Funding (current)")).toBeNull();
  });

  it("binds the workspace treatment to the selected Lighter environment", async () => {
    renderDialog();

    const workspace = document.querySelector('[data-vex-area="lighter-trading-dialog"]');
    const environment = screen.getByRole("combobox", { name: "Lighter network" });

    expect(workspace?.getAttribute("data-lighter-environment")).toBe("rhc");
    expect(await screen.findByText("Robinhood Chain · Lighter markets")).toBeTruthy();

    fireEvent.click(await screen.findByRole("button", { name: /BTC.*perp.*active/i }));
    expect(screen.getByRole("dialog", { name: "Search Lighter markets" })).toBeTruthy();

    fireEvent.change(environment, { target: { value: "core" } });

    await waitFor(() => {
      expect(workspace?.getAttribute("data-lighter-environment")).toBe("core");
      expect(screen.getByText("Lighter Core markets")).toBeTruthy();
      expect(screen.queryByRole("dialog", { name: "Search Lighter markets" })).toBeNull();
    });
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
    await waitFor(() => expect(screen.getByText("24h volume (USDG)")).toBeTruthy());
    expect(screen.getByRole("region", { name: "Selected market summary" }).getAttribute("data-market-type"))
      .toBe("spot");
    expect(screen.queryByText("Open interest (USD)")).toBeNull();
    expect(screen.queryByText("Funding (current)")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /SPY.*SPY\/USDG.*Spot.*active/i }));
    expect(screen.getAllByText("0.0003%").length).toBeGreaterThan(0);
    expect(screen.queryByText("0.03%")).toBeNull();
  });

  it("defaults Spot to the active market with the strongest 24h quote volume", async () => {
    renderDialog();

    fireEvent.click(await screen.findByRole("button", { name: "Spot" }));

    expect(await screen.findByRole("button", { name: /SPY.*SPY\/USDG.*Spot.*active/i }))
      .toBeTruthy();
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

    expect(await screen.findByRole("heading", { name: "Vex trading desk" })).toBeTruthy();
    expect(screen.getByText("Desk ready")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Build the BTC trade from the tape." }))
      .toBeTruthy();
    expect(screen.getByText(
      "Work from the live 5m chart, order book, and recent flow—all inside one focused session.",
    )).toBeTruthy();
    expect(screen.getByRole("group", { name: "Trading desk prompts" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", {
      name: /Mark the chart.*Structure, liquidity, key levels, and invalidation/i,
    }));
    expect(mocks.onCreateSession).toHaveBeenCalledWith(expect.stringContaining(
      "environment=rhc, marketId=1, marketType=perp, symbol=BTC, candleInterval=5m",
    ));
    expect(mocks.onCreateSession).toHaveBeenLastCalledWith(expect.stringContaining(
      "market structure, liquidity, key levels, and clear invalidation",
    ));

    fireEvent.click(screen.getByRole("button", {
      name: /Read the tape.*Aggression, absorption, and order-book pressure/i,
    }));
    expect(mocks.onCreateSession).toHaveBeenLastCalledWith(expect.stringContaining(
      "Assess aggression, possible absorption, and order-book pressure",
    ));

    fireEvent.click(screen.getByRole("button", {
      name: /Build the play.*Entry trigger, stop, targets, and risk-to-reward/i,
    }));
    expect(mocks.onCreateSession).toHaveBeenLastCalledWith(expect.stringContaining(
      "entry trigger, invalidation, stop, targets, risk-to-reward",
    ));

    fireEvent.click(screen.getByRole("button", { name: "Open the BTC desk" }));
    expect(mocks.onCreateSession).toHaveBeenLastCalledWith();
  });

  it("searches and selects a real provider market from the Lighter-style picker", async () => {
    renderDialog();

    fireEvent.click(await screen.findByRole("button", { name: /BTC.*perp.*active/i }));
    const search = screen.getByRole("combobox", { name: "Search Lighter markets" });
    fireEvent.change(search, { target: { value: "USDG" } });

    const option = screen.getByRole("option", { name: /ETH\/USDG.*Spot.*active/i });
    expect(within(option).getByText("ETH/USDG")).toBeTruthy();
    expect(within(option).getByText("Spot")).toBeTruthy();
    expect(screen.getByText("Minimum size")).toBeTruthy();
    expect(screen.getByText("Minimum value")).toBeTruthy();
    fireEvent.click(option);

    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Search Lighter markets" })).toBeNull();
      expect(screen.getByRole("button", { name: /ETH.*ETH\/USDG.*Spot.*active/i })).toBeTruthy();
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

  it("keeps the full provider ticker visible beside a reviewed market mark", async () => {
    renderDialog();

    fireEvent.click(await screen.findByRole("button", { name: /BTC.*perp.*active/i }));
    const option = screen.getByRole("option", { name: /AAPL.*Perpetual.*active/i });

    expect(within(option).getByTitle("AAPL")).toBeTruthy();
    expect(option.querySelector('[data-market-mark="brand"] svg')).not.toBeNull();
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
  baseAssetId = marketType === "perp" ? 0 : 1,
  quoteAssetId = marketType === "perp" ? 0 : 3,
  tradesCount = 0,
  quoteVolume = 0,
): LighterTradingMarketList["markets"][number] {
  return {
    marketId,
    symbol,
    marketType,
    status: "active",
    baseAssetId,
    quoteAssetId,
    minBaseAmount: "0.001",
    minQuoteAmount: "10",
    orderQuoteLimit: "100000",
    decimals: { size: 4, price: 2, quote: 6 },
    fees: { maker: "0", taker: "0.0003", makerEnabled: false, takerEnabled: true },
    activity24h: { tradesCount, quoteVolume },
  };
}
