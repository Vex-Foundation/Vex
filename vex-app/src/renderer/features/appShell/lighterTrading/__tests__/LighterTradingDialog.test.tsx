import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  LighterTradingMarketList,
  LighterTradingSnapshot,
} from "@shared/schemas/lighter-trading.js";
import { LighterTradingDialog } from "../LighterTradingDialog.js";

const mocks = vi.hoisted(() => ({ onOpenChange: vi.fn() }));

const MARKET_LIST: LighterTradingMarketList = {
  environment: "rhc",
  retrievedAt: 1_720_000_000_000,
  markets: [
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
      />,
    );
    expect(screen.queryByTestId("active-session-chat")).toBeNull();
  });

  it("starts on Lighter's live 5m interval and does not expose unsupported weekly streaming", async () => {
    renderDialog();

    expect((await screen.findByRole("button", { name: "5m" })).getAttribute("aria-pressed"))
      .toBe("true");
    expect(screen.queryByRole("button", { name: "1w" })).toBeNull();
  });

  it("searches and selects a real provider market from the Lighter-style picker", async () => {
    renderDialog();

    fireEvent.click(await screen.findByRole("button", { name: /ETH.*perp.*active/i }));
    const search = screen.getByRole("textbox", { name: "Search Lighter markets" });
    fireEvent.change(search, { target: { value: "USDC" } });

    const option = screen.getByRole("option", { name: /ETH\/USDC.*Spot.*active/i });
    fireEvent.click(option);

    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Search Lighter markets" })).toBeNull();
      expect(screen.getByRole("button", { name: /ETH\/USDC.*spot.*active/i })).toBeTruthy();
    });
  });
});

function renderDialog(): ReturnType<typeof render> {
  return render(
    <LighterTradingDialog
      open
      activeSessionId="session-1"
      onOpenChange={mocks.onOpenChange}
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
    fees: { maker: "0", taker: "0.0003" },
  };
}
