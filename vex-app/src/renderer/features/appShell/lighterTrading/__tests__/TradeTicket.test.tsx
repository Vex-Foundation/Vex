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
    expect(orderTypes.textContent).toContain("Limit");
    expect(orderTypes.textContent).toContain("Stop loss");
    expect(orderTypes.textContent).toContain("Stop-loss limit");
    expect(orderTypes.textContent).toContain("Take profit");
    expect(orderTypes.textContent).toContain("Take-profit limit");
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
    expect(screen.getByText("24 hours")).toBeTruthy();
    expect(screen.queryByText("Preview expiry")).toBeNull();
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
    expect((screen.getByRole("button", { name: "Limit" }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole("button", { name: "Stop loss" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Stop-loss limit" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Take profit" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Take-profit limit" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "SL + TP" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/plain Limit orders here/i)).toBeTruthy();
    expect(screen.getByText(/Position protection requires a perpetual market/i)).toBeTruthy();
  });

  it.each([
    ["Immediate only", "immediate-or-cancel", false, 30, /would cancel instead of resting/i],
    ["Keep open", "good-till-time", true, 240, /can rest until the market reaches it/i],
    ["Maker only", "post-only", true, 240, /can rest as a maker order/i],
  ] as const)(
    "emits an exact plain limit draft for %s without reusing the market bound",
    (tifLabel, timeInForce, hasExpiryControl, expectedExpiry, priceGuidance) => {
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

      fireEvent.click(screen.getByRole("button", { name: "Limit" }));
      fireEvent.change(screen.getByLabelText("Base size"), { target: { value: "0.2" } });
      fireEvent.change(screen.getByLabelText("Limit price"), { target: { value: "3190.25" } });
      fireEvent.click(screen.getByRole("button", { name: tifLabel }));
      if (hasExpiryControl) {
        fireEvent.change(screen.getByLabelText("Order expiry"), { target: { value: "240" } });
      } else {
        expect(screen.queryByLabelText("Order expiry")).toBeNull();
      }
      fireEvent.click(screen.getByRole("button", { name: "Review limit order" }));

      expect(onReview).toHaveBeenCalledWith({
        mode: "limit",
        side: "buy",
        baseAmount: "0.2",
        limitPrice: "3190.25",
        timeInForce,
        orderExpiryOffsetMinutes: expectedExpiry,
        reduceOnly: false,
      });
      if (timeInForce === "immediate-or-cancel") {
        expect(screen.getByText("None (immediate only)")).toBeTruthy();
      }
      expect(screen.getByText(priceGuidance)).toBeTruthy();
    },
  );

  it("defaults a plain limit to keep open for one day", () => {
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

    fireEvent.click(screen.getByRole("button", { name: "Limit" }));
    fireEvent.change(screen.getByLabelText("Base size"), { target: { value: "0.2" } });
    fireEvent.change(screen.getByLabelText("Limit price"), { target: { value: "3190.25" } });

    expect(screen.getByRole("button", { name: "Keep open" }).getAttribute("aria-pressed")).toBe("true");
    expect((screen.getByLabelText("Order expiry") as HTMLSelectElement).value).toBe("1440");
    expect(screen.getByText("Unfilled amount stays open until filled, canceled, or the selected expiry.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Review limit order" }));
    expect(onReview).toHaveBeenCalledWith({
      mode: "limit",
      side: "buy",
      baseAmount: "0.2",
      limitPrice: "3190.25",
      timeInForce: "good-till-time",
      orderExpiryOffsetMinutes: 1_440,
      reduceOnly: false,
    });
  });

  it("defaults only ordinary limits while keeping trigger-limit behavior explicit", () => {
    render(
      <TradeTicket
        market={PERP}
        book={BOOK}
        activeSession
        dataFresh
        submitting={false}
        onReview={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Limit" }));
    fireEvent.change(screen.getByLabelText("Order expiry"), { target: { value: "240" } });
    expect(screen.getByRole("button", { name: "Keep open" }).getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "Stop-loss limit" }));
    expect(screen.getByRole("button", { name: "Immediate only" }).getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByRole("button", { name: "Keep open" }).getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByRole("button", { name: "Maker only" }).getAttribute("aria-pressed")).toBe("false");
    expect((screen.getByLabelText("Order expiry") as HTMLSelectElement).value).toBe("240");
    expect(screen.getByText(/Choose what should happen to the limit order after it is activated/i)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Immediate only" }));
    expect(screen.getByText("Conditional fill or cancel")).toBeTruthy();
    expect((screen.getByLabelText("Order expiry") as HTMLSelectElement).value).toBe("240");

    fireEvent.click(screen.getByRole("button", { name: "Limit" }));
    expect(screen.getByRole("button", { name: "Keep open" }).getAttribute("aria-pressed")).toBe("true");
    expect((screen.getByLabelText("Order expiry") as HTMLSelectElement).value).toBe("240");
  });

  it.each([
    ["Stop-loss limit", "stop-loss-limit", "Immediate only", "immediate-or-cancel"],
    ["Stop-loss limit", "stop-loss-limit", "Keep open", "good-till-time"],
    ["Stop-loss limit", "stop-loss-limit", "Maker only", "post-only"],
    ["Take-profit limit", "take-profit-limit", "Immediate only", "immediate-or-cancel"],
    ["Take-profit limit", "take-profit-limit", "Keep open", "good-till-time"],
    ["Take-profit limit", "take-profit-limit", "Maker only", "post-only"],
  ] as const)("emits an exact native %s %s draft with explicit expiry", (buttonName, mode, tifLabel, timeInForce) => {
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

    fireEvent.click(screen.getByRole("button", { name: buttonName }));
    fireEvent.click(screen.getByRole("button", { name: "Sell" }));
    fireEvent.change(screen.getByLabelText("Base size"), { target: { value: "0.1" } });
    fireEvent.change(screen.getByLabelText(`${buttonName} trigger price`), { target: { value: "2900" } });
    fireEvent.change(screen.getByLabelText(`${buttonName} limit price`), { target: { value: "2875" } });
    fireEvent.click(screen.getByRole("button", { name: tifLabel }));
    fireEvent.change(screen.getByLabelText("Order expiry"), { target: { value: "240" } });
    fireEvent.click(screen.getByRole("button", { name: `Review ${buttonName.toLowerCase()}` }));

    expect(onReview).toHaveBeenCalledWith({
      mode,
      side: "sell",
      baseAmount: "0.1",
      triggerPrice: "2900",
      limitPrice: "2875",
      timeInForce,
      orderExpiryOffsetMinutes: 240,
      reduceOnly: true,
    });
    const behavior = screen.getByRole("group", { name: "Order behavior" });
    expect(behavior.getAttribute("aria-describedby")).toBe("lit-order-behavior-note");
  });

  it("requires an explicit trigger-limit time in force and offers a buffered minimum expiry", () => {
    render(
      <TradeTicket
        market={PERP}
        book={BOOK}
        activeSession
        dataFresh
        submitting={false}
        onReview={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Stop-loss limit" }));
    fireEvent.click(screen.getByRole("button", { name: "Sell" }));
    fireEvent.change(screen.getByLabelText("Base size"), { target: { value: "0.1" } });
    fireEvent.change(screen.getByLabelText("Stop-loss limit trigger price"), { target: { value: "2900" } });
    fireEvent.change(screen.getByLabelText("Stop-loss limit limit price"), { target: { value: "2875" } });

    expect(screen.getByText("Choose how the triggered limit should behave.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Review stop-loss limit" }) as HTMLButtonElement).disabled).toBe(true);
    const expiry = screen.getByLabelText("Order expiry") as HTMLSelectElement;
    expect(Array.from(expiry.options).map((option) => option.value)).not.toContain("5");
    expect(Array.from(expiry.options).map((option) => option.value)).toContain("10");
  });

  it("blocks a post-only limit price that crosses the fresh opposite side", () => {
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

    fireEvent.click(screen.getByRole("button", { name: "Limit" }));
    fireEvent.change(screen.getByLabelText("Base size"), { target: { value: "0.2" } });
    fireEvent.change(screen.getByLabelText("Limit price"), { target: { value: "3210.50" } });
    fireEvent.click(screen.getByRole("button", { name: "Maker only" }));

    expect(screen.getByText("Maker-only buy price must stay below the best ask.")).toBeTruthy();
    expect(screen.getByText(/this price crosses the live book, so Maker only cannot be reviewed/i)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Review limit order" }) as HTMLButtonElement).disabled).toBe(true);
    expect(onReview).not.toHaveBeenCalled();
  });

  it("explains side-aware resting and marketable prices from the live book", () => {
    render(
      <TradeTicket
        market={PERP}
        book={BOOK}
        activeSession
        dataFresh
        submitting={false}
        onReview={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Limit" }));
    fireEvent.change(screen.getByLabelText("Limit price"), { target: { value: "3200" } });
    expect(screen.getByText(/this price can rest until the market reaches it/i)).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Limit price"), { target: { value: "3210.50" } });
    expect(screen.getByText(/this price can fill immediately/i)).toBeTruthy();
    expect(screen.getByText(/any unfilled amount stays open/i)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Sell" }));
    fireEvent.change(screen.getByLabelText("Limit price"), { target: { value: "3200" } });
    expect(screen.getByText(/this price can rest until the market reaches it/i)).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Limit price"), { target: { value: "3199.50" } });
    expect(screen.getByText(/this price can fill immediately/i)).toBeTruthy();
  });
});
