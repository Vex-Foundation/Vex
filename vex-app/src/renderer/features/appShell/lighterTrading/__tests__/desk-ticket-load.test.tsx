import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LighterTradingMarket } from "@shared/schemas/lighter-trading.js";
import { useUiStore } from "../../../../stores/uiStore.js";
import { DeskTicketLoadStamp } from "../DeskTicketLoadStamp.js";
import { findLoadMarket, parseDeskTicketLoad, useDeskTicketLoadStore } from "../desk-ticket-load.js";

const TOOL = "lighter__order_preview";

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
const SPOT: LighterTradingMarket = { ...PERP, marketId: 2048, symbol: "ETH/USDG", marketType: "spot" };

function args(value: Record<string, unknown>): string {
  return JSON.stringify(value);
}

describe("parseDeskTicketLoad", () => {
  it("maps a limit preview onto the ticket, keeping only the fields a limit uses", () => {
    const load = parseDeskTicketLoad(TOOL, args({
      environment: "core", marketSymbol: "eth", marketType: "perp", side: "buy", baseAmountIn: "0.5",
      price: "3150", orderType: "limit", timeInForce: "post-only", orderExpiryOffsetMinutes: 240,
    }));
    expect(load).toEqual({
      environment: "core",
      marketId: null,
      marketSymbol: "ETH",
      marketType: "perp",
      prefill: {
        mode: "limit", side: "buy", baseAmount: "0.5", reduceOnly: false,
        price: "3150", timeInForce: "post-only", expiryMinutes: 240,
      },
    });
  });

  it("drops a market preview's slippage bound and defaults the environment to rhc", () => {
    const load = parseDeskTicketLoad(TOOL, args({
      marketId: 7, side: "sell", baseAmountIn: "1", price: "3000", reduceOnly: true, orderExpiryOffsetMinutes: 30,
    }));
    expect(load?.environment).toBe("rhc");
    expect(load?.marketId).toBe(7);
    expect(load?.prefill).toEqual({ mode: "market", side: "sell", baseAmount: "1", reduceOnly: true });
  });

  it("carries a trigger and its bound for a protective preview", () => {
    const load = parseDeskTicketLoad(TOOL, args({
      marketSymbol: "ETH", side: "sell", baseAmountIn: "1", price: "2950", triggerPrice: "3000",
      orderType: "stop-loss", reduceOnly: true, orderExpiryOffsetMinutes: 30,
    }));
    expect(load?.prefill).toEqual({
      mode: "stop-loss", side: "sell", baseAmount: "1", reduceOnly: true, price: "2950", triggerPrice: "3000",
    });
  });

  it("refuses other tools, malformed args, no market, no side, and an untyped trigger", () => {
    const base = { marketSymbol: "ETH", side: "buy", baseAmountIn: "1" };
    expect(parseDeskTicketLoad("lighter__order_create_prepare", args(base))).toBeNull();
    expect(parseDeskTicketLoad(TOOL, null)).toBeNull();
    expect(parseDeskTicketLoad(TOOL, "{not json")).toBeNull();
    expect(parseDeskTicketLoad(TOOL, args({ side: "buy", baseAmountIn: "1" }))).toBeNull();
    expect(parseDeskTicketLoad(TOOL, args({ marketSymbol: "ETH", baseAmountIn: "1" }))).toBeNull();
    expect(parseDeskTicketLoad(TOOL, args({ ...base, baseAmountIn: "lots" }))).toBeNull();
    expect(parseDeskTicketLoad(TOOL, args({ ...base, triggerPrice: "3000" }))).toBeNull();
  });
});

describe("findLoadMarket", () => {
  const markets = [SPOT, PERP];

  it("resolves by id, then by exact pair, then by base with perps first", () => {
    expect(findLoadMarket(markets, { marketId: 2048, marketSymbol: null, marketType: null })).toBe(SPOT);
    expect(findLoadMarket(markets, { marketId: null, marketSymbol: "ETH/USDG", marketType: null })).toBe(SPOT);
    expect(findLoadMarket(markets, { marketId: null, marketSymbol: "ETH", marketType: null })).toBe(PERP);
    expect(findLoadMarket(markets, { marketId: null, marketSymbol: "ETH", marketType: "spot" })).toBe(SPOT);
    expect(findLoadMarket(markets, { marketId: 9, marketSymbol: "ETH", marketType: null })).toBeNull();
    expect(findLoadMarket(markets, { marketId: null, marketSymbol: "BTC", marketType: null })).toBeNull();
  });
});

describe("DeskTicketLoadStamp", () => {
  const act = {
    toolCallId: "c1",
    toolName: TOOL,
    toolArgs: args({ marketSymbol: "ETH", side: "buy", baseAmountIn: "0.5", price: "3150", orderType: "limit", orderExpiryOffsetMinutes: 1440 }),
    output: null,
  };

  beforeEach(() => {
    useDeskTicketLoadStore.setState({ pending: null });
  });
  afterEach(() => {
    useUiStore.setState({ runtimeMode: "agent" });
    useDeskTicketLoadStore.setState({ pending: null });
  });

  it("publishes the parsed load only from the Lighter desk", () => {
    const { rerender } = render(<DeskTicketLoadStamp act={act} />);
    expect(screen.queryByRole("button", { name: /Load this order preview/ })).toBeNull();

    useUiStore.setState({ runtimeMode: "lighter" });
    rerender(<DeskTicketLoadStamp act={act} />);
    fireEvent.click(screen.getByRole("button", { name: /Load this order preview/ }));
    const pending = useDeskTicketLoadStore.getState().pending;
    expect(pending?.marketSymbol).toBe("ETH");
    expect(pending?.prefill).toEqual({
      mode: "limit", side: "buy", baseAmount: "0.5", reduceOnly: false, price: "3150", expiryMinutes: 1440,
    });
  });
});
