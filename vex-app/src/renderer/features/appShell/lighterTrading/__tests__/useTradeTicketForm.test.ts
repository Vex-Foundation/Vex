import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { LighterTradingMarket } from "@shared/schemas/lighter-trading.js";
import { useTradeTicketForm } from "../useTradeTicketForm.js";
import type { TicketMargin } from "../ticket-model.js";

const SPOT: LighterTradingMarket = {
  marketId: 2048,
  symbol: "ETH/USDG",
  marketType: "spot",
  status: "active",
  baseAssetId: 1,
  quoteAssetId: 3,
  minBaseAmount: "0.001",
  minQuoteAmount: "10",
  orderQuoteLimit: "100000",
  decimals: { size: 4, price: 2, quote: 6 },
  fees: { maker: "0", taker: "0.1", makerEnabled: false, takerEnabled: true, integratorMaker: "0.1", integratorTaker: "0.1" },
  activity24h: { tradesCount: 1, quoteVolume: 1 },
};

const PERP: LighterTradingMarket = {
  ...SPOT,
  marketId: 7,
  symbol: "ETH",
  marketType: "perp",
  margin: { defaultInitialMarginFraction: 1_000, minInitialMarginFraction: 200, maintenanceMarginFraction: 400 },
};

const BOOK = { asks: [{ price: "100", size: "10" }], bids: [{ price: "99", size: "10" }] };
const MARGIN: TicketMargin = { initialMarginFraction: 1_000, maintenanceMarginFraction: 400, marginMode: "cross", source: "market" };

function form(market: LighterTradingMarket, overrides: Partial<Parameters<typeof useTradeTicketForm>[0]> = {}) {
  return renderHook(() => useTradeTicketForm({
    market,
    book: BOOK,
    lastPrice: 99.5,
    available: "100",
    equity: 100,
    margin: market.marketType === "perp" ? MARGIN : null,
    dataFresh: true,
    ...overrides,
  }));
}

describe("useTradeTicketForm balance sizing", () => {
  it("uses spot base inventory for Sell Max and floors to the size step", () => {
    const view = form(SPOT, { available: "5000", baseAvailable: "2.34567" });
    act(() => view.result.current.setSide("sell"));
    expect(view.result.current.maxSize).toBe("2.3456");
  });

  it("reserves buy fees and the market worst price in Max", () => {
    const view = form(SPOT, { available: "100", baseAvailable: "0" });
    // Best ask 100, 0.5% default slippage, 0.1% provider taker fee and Vex's
    // own 0.1%: both are charged against the same balance, so Max reserves both.
    expect(view.result.current.maxSize).toBe("0.993");
  });

  it("rejects a base amount whose quote value is below the market minimum", () => {
    const view = form(SPOT, { available: "100", baseAvailable: null });
    act(() => view.result.current.editSize("0.05"));
    expect(view.result.current.validation).toBe("Minimum order value is 10 USDG.");
  });

  it("still reserves Vex's fee when the provider charges nothing", () => {
    // The live RHC shape: Lighter's own taker fee reads zero, so sizing on it
    // alone spent the whole balance on margin and the exchange refused the
    // order for margin it no longer had.
    const free = { ...SPOT, fees: { ...SPOT.fees, taker: "0", takerEnabled: false } };
    expect(form(free, { available: "100", baseAvailable: "0" }).result.current.maxSize).toBe("0.994");
    const noVex = { ...free, fees: { ...free.fees, integratorTaker: null } };
    expect(form(noVex, { available: "100", baseAvailable: "0" }).result.current.maxSize).toBe("0.995");
  });

  it("estimates both fee legs, not just the provider's", () => {
    const view = form(SPOT, { available: "100", baseAvailable: "0" });
    act(() => view.result.current.editSize("0.5"));
    // 0.5 at the 100.5 worst price: 50.25 notional at 0.1% + 0.1%.
    expect(view.result.current.estimatedFee).toBeCloseTo(50.25 * 0.002, 10);
  });

  it("floors leveraged Max so the margin plus fee cannot exceed available", () => {
    const view = form(PERP, { available: "1", margin: MARGIN });
    const max = Number(view.result.current.maxSize);
    expect(max).toBeLessThanOrEqual(1 / (1000 / 10_000 + 0.001 + 0.001) / 100.5);
    expect(max).toBe(Number(max.toFixed(4)));
  });
});
