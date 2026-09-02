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
    ["IOC", "immediate-or-cancel", false, 30],
    ["GTT", "good-till-time", true, 240],
    ["Post only", "post-only", true, 240],
  ] as const)(
    "emits an exact plain limit draft for %s without reusing the market bound",
    (tifLabel, timeInForce, hasExpiryControl, expectedExpiry) => {
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
        expect(screen.getByText("None (IOC)")).toBeTruthy();
      }
      expect(screen.getByText("Exact price for this limit order; it is not a market execution bound.")).toBeTruthy();
    },
  );

  it("requires a plain-limit time in force instead of inferring one", () => {
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
    fireEvent.change(screen.getByLabelText("Base size"), { target: { value: "0.2" } });
    fireEvent.change(screen.getByLabelText("Limit price"), { target: { value: "3190.25" } });

    expect(screen.getByText("Choose how long the limit order should remain active.")).toBeTruthy();
    expect(screen.getByText(/Vex will not infer one/i)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Review limit order" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByLabelText("Order expiry")).toBeNull();
  });

  it("resets time in force across limit-family mode switches while keeping trigger expiry explicit", () => {
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
    fireEvent.click(screen.getByRole("button", { name: "GTT" }));
    fireEvent.change(screen.getByLabelText("Order expiry"), { target: { value: "240" } });
    expect(screen.getByRole("button", { name: "GTT" }).getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "Stop-loss limit" }));
    expect(screen.getByRole("button", { name: "IOC" }).getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByRole("button", { name: "GTT" }).getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByRole("button", { name: "Post only" }).getAttribute("aria-pressed")).toBe("false");
    expect((screen.getByLabelText("Order expiry") as HTMLSelectElement).value).toBe("240");
    expect(screen.getByText(/Vex will not infer one/i)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "IOC" }));
    expect(screen.getByText("Conditional fill or cancel")).toBeTruthy();
    expect((screen.getByLabelText("Order expiry") as HTMLSelectElement).value).toBe("240");

    fireEvent.click(screen.getByRole("button", { name: "Limit" }));
    expect(screen.getByRole("button", { name: "IOC" }).getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByText(/Vex will not infer one/i)).toBeTruthy();
    expect(screen.queryByLabelText("Order expiry")).toBeNull();
  });

  it.each([
    ["Stop-loss limit", "stop-loss-limit", "IOC", "immediate-or-cancel"],
    ["Stop-loss limit", "stop-loss-limit", "GTT", "good-till-time"],
    ["Stop-loss limit", "stop-loss-limit", "Post only", "post-only"],
    ["Take-profit limit", "take-profit-limit", "IOC", "immediate-or-cancel"],
    ["Take-profit limit", "take-profit-limit", "GTT", "good-till-time"],
    ["Take-profit limit", "take-profit-limit", "Post only", "post-only"],
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
    expect(screen.getByRole("group", { name: "Limit time in force" })).toBeTruthy();
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

    expect(screen.getByText("Choose the trigger-limit time in force.")).toBeTruthy();
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
    fireEvent.click(screen.getByRole("button", { name: "Post only" }));

    expect(screen.getByText("Post-only buy price must stay below the best ask.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Review limit order" }) as HTMLButtonElement).disabled).toBe(true);
    expect(onReview).not.toHaveBeenCalled();
  });
});
