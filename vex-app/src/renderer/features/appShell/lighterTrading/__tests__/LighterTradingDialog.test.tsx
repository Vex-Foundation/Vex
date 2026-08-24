import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  LighterTradingMarketList,
  LighterTradingSnapshot,
} from "@shared/schemas/lighter-trading.js";
import { LighterTradingDialog } from "../LighterTradingDialog.js";

const mocks = vi.hoisted(() => ({
  submitChat: vi.fn(),
  onOpenChange: vi.fn(),
}));

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

vi.mock("../../../../lib/api/chat.js", () => ({
  useSubmitChat: () => ({
    isPending: false,
    mutate: mocks.submitChat,
  }),
}));

vi.mock("../../../../stores/uiStore.js", () => ({
  useUiStore: (selector: (state: { theme: "chronos" }) => unknown) => selector({ theme: "chronos" }),
}));

vi.mock("../MarketChart.js", () => ({
  MarketChart: () => <div data-testid="real-chart-host" />,
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

  it("hands Review order only to the deterministic preview chat flow", async () => {
    renderDialog();

    fireEvent.change(await screen.findByLabelText(/Base size/), {
      target: { value: "0.02" },
    });
    const price = screen.getByLabelText(/Maximum buy price/);
    await waitFor(() => expect((price as HTMLInputElement).value).toBe("3210.50"));
    fireEvent.click(screen.getByRole("button", { name: "Review order" }));

    expect(mocks.submitChat).toHaveBeenCalledTimes(1);
    expect(mocks.submitChat).toHaveBeenCalledWith(
      {
        sessionId: "session-1",
        message: expect.stringMatching(
          /^Review this exact Lighter trade as a preview only\. Do not place or submit it\.; .*orderType=market; timeInForce=immediate-or-cancel; .*Nothing may execute without the separate approval card\.$/,
        ),
      },
      expect.objectContaining({
        onSuccess: expect.any(Function),
        onError: expect.any(Function),
      }),
    );
  });
});

function renderDialog(): void {
  render(
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
