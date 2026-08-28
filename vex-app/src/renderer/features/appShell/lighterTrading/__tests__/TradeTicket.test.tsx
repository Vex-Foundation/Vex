import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { LighterTradingMarket } from "@shared/schemas/lighter-trading.js";
import { TradeTicket } from "../TradeTicket.js";

const PERP: LighterTradingMarket = {
  marketId: 7,
  symbol: "ETH",
  marketType: "perp",
  status: "active",
  baseAssetId: 1,
  quoteAssetId: 3,
  minBaseAmount: "0.001",
  minQuoteAmount: "10",
  orderQuoteLimit: "100000",
  decimals: { size: 4, price: 2, quote: 6 },
  fees: { maker: "0", taker: "0.0003", makerEnabled: false, takerEnabled: true },
  activity24h: { tradesCount: 120, quoteVolume: 1_600_000 },
};

const BOOK = {
  asks: [{ orderId: "a1", price: "3210.50", size: "4" }],
  bids: [{ orderId: "b1", price: "3199.50", size: "3" }],
};

describe("Light it up trade ticket", () => {
  it("shows every supported create mode and emits an exact native OCO draft", () => {
    const onReview = vi.fn();
    render(
      <TradeTicket
        market={PERP}
        book={BOOK}
        activeSession
        dataFresh
        submitting={false}
        onReview={onReview}
      />,
    );

    const orderTypes = screen.getByRole("group", { name: "Order type" });
    expect(orderTypes.textContent).toContain("Market");
    expect(orderTypes.textContent).toContain("Stop loss");
    expect(orderTypes.textContent).toContain("Take profit");
    expect(orderTypes.textContent).toContain("SL + TP");

    fireEvent.click(screen.getByRole("button", { name: "SL + TP" }));
    fireEvent.click(screen.getByRole("button", { name: "Sell" }));
    fireEvent.change(screen.getByLabelText("Base size"), { target: { value: "0.1" } });
    fireEvent.change(screen.getByLabelText("Stop loss trigger price"), { target: { value: "2900" } });
    fireEvent.change(screen.getByLabelText("Stop loss minimum sell price"), { target: { value: "2850" } });
    fireEvent.change(screen.getByLabelText("Take profit trigger price"), { target: { value: "3300" } });
    fireEvent.change(screen.getByLabelText("Take profit minimum sell price"), { target: { value: "3250" } });
    fireEvent.click(screen.getByRole("button", { name: "Review SL + TP protection" }));

    expect(onReview).toHaveBeenCalledWith({
      mode: "oco",
      side: "sell",
      baseAmount: "0.1",
      stopLossTriggerPrice: "2900",
      stopLossPrice: "2850",
      takeProfitTriggerPrice: "3300",
      takeProfitPrice: "3250",
    });
    expect(screen.getByText("Native OCO")).toBeTruthy();
    expect(screen.getByText(/does not sign or submit an order/i)).toBeTruthy();
  });

  it("keeps protection unavailable on spot instead of presenting a broken path", () => {
    render(
      <TradeTicket
        market={{ ...PERP, marketId: 2048, symbol: "ETH/USDG", marketType: "spot" }}
        book={BOOK}
        activeSession
        dataFresh
        submitting={false}
        onReview={vi.fn()}
      />,
    );

    expect((screen.getByRole("button", { name: "Market" }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole("button", { name: "Stop loss" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Take profit" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "SL + TP" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Position protection requires a perpetual market/i)).toBeTruthy();
  });
});
