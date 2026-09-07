import { requireValue } from "../../../../../../../src/__tests__/helpers/require-value.js";
import { useLighterAnalysisStore } from "../../../../stores/lighterAnalysisStore.js";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LighterTradingMarket } from "@shared/schemas/lighter-trading.js";
import { MarketPicker } from "../MarketPicker.js";

const makeMarket = (id: number, symbol: string, price: number | null, overrides: Partial<LighterTradingMarket> = {}): LighterTradingMarket => ({
  marketId: id, symbol, marketType: "perp", status: "active", baseAssetId: 0, quoteAssetId: 0,
  minBaseAmount: "0.001", minQuoteAmount: "10", orderQuoteLimit: "100000",
  decimals: { size: 3, price: 2, quote: 5 },
  fees: { maker: "0", taker: "0", makerEnabled: false, takerEnabled: false },
  activity24h: { tradesCount: 50, quoteVolume: price === null ? null : price * 100 },
  statistics: { lastTradePrice: price, priceChange24h: price === null ? null : -1.2, openInterestBase: price === null ? null : 500 },
  ...overrides,
});
const markets = [makeMarket(1, "BTC", 60000), makeMarket(0, "ETH", 3000), makeMarket(3, "UNKNOWN", null)];
const baseProps = { environment: "rhc" as const, markets, selectedMarketId: 1, onSelect: vi.fn(), onClose: vi.fn() };
const symbols = (): (string | null)[] => screen.getAllByRole("option").map((row) => row.querySelector("b")?.textContent ?? null);

beforeEach(() => { vi.restoreAllMocks(); localStorage.clear(); useLighterAnalysisStore.setState({ charts: {}, favorites: [] }); baseProps.onSelect.mockReset(); baseProps.onClose.mockReset(); });

describe("market picker", () => {
  it("displays actual metrics and explicit base units while unavailable data stays empty", () => {
    render(<MarketPicker {...baseProps} />);
    const btc = screen.getByRole("option", { name: /BTC, Perpetual, active/ });
    expect(within(btc).getByText("60,000.00")).toBeTruthy();
    expect(within(btc).getByText("-1.2%")).toBeTruthy();
    expect(within(btc).getByText("$6M")).toBeTruthy();
    expect(within(btc).getByText("500 BTC")).toBeTruthy();
    expect(within(screen.getByRole("option", { name: /UNKNOWN/ })).getAllByText("—")).toHaveLength(4);
    expect(screen.queryByText("Minimum size")).toBeNull();
  });

  it("preserves the provider ordering as prices change until an explicit sort", () => {
    const view = render(<MarketPicker {...baseProps} />);
    view.rerender(<MarketPicker {...baseProps} markets={[makeMarket(1, "BTC", 1), makeMarket(0, "ETH", 99999), requireValue(markets[2])]} />);
    expect(symbols()).toEqual(["BTC", "ETH", "UNKNOWN"]);
    fireEvent.click(screen.getByRole("button", { name: "Sort by Price" }));
    expect(symbols()).toEqual(["ETH", "BTC", "UNKNOWN"]);
    fireEvent.click(screen.getByRole("button", { name: "Sort by Price" }));
    expect(symbols()).toEqual(["BTC", "ETH", "UNKNOWN"]);
    expect(screen.getByText("Sorted by Price, ascending")).toBeTruthy();
  });

  it("stores favorites using environment and full product identity without selecting the row", () => {
    const spot = makeMarket(1, "BTC", 60000, { marketType: "spot", baseAssetId: 2, quoteAssetId: 3 });
    const view = render(<MarketPicker {...baseProps} markets={[requireValue(markets[0]), spot]} />);
    fireEvent.click(screen.getByRole("button", { name: "Add BTC Perpetual to favorites" }));
    expect(baseProps.onSelect).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Favorites" }));
    expect(screen.getAllByRole("option")).toHaveLength(1);
    expect(screen.getByRole("option", { name: /BTC, Perpetual, active, favorite/ })).toBeTruthy();
    view.unmount();
    const core = render(<MarketPicker {...baseProps} environment="core" />);
    fireEvent.click(screen.getByRole("button", { name: "Favorites" }));
    expect(screen.queryByRole("option")).toBeNull();
    core.unmount();
    render(<MarketPicker {...baseProps} />);
    expect(screen.getByRole("button", { name: "Remove BTC Perpetual from favorites" })).toBeTruthy();
  });

  it("supports keyboard navigation, favoriting, filtering, and the current result identity", () => {
    render(<MarketPicker {...baseProps} />);
    const search = screen.getByRole("combobox");
    fireEvent.keyDown(search, { key: "ArrowDown" });
    fireEvent.keyDown(search, { key: "f", altKey: true });
    expect(screen.getByRole("button", { name: "Remove ETH Perpetual from favorites" })).toBeTruthy();
    fireEvent.change(search, { target: { value: "unknown" } });
    expect(search.getAttribute("aria-activedescendant")).toBe(screen.getByRole("option").id);
    fireEvent.keyDown(search, { key: "Enter" });
    expect(baseProps.onSelect).toHaveBeenCalledWith(markets[2]);
  });

  it("aligns the initial selected row below the sticky header, then keeps keyboard movement nearby", () => {
    const scrollIntoView = vi.fn();
    const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView");
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: scrollIntoView });
    try {
      render(<MarketPicker {...baseProps} />);
      expect(scrollIntoView).toHaveBeenLastCalledWith({ block: "start" });
      const search = screen.getByRole("combobox");
      fireEvent.keyDown(search, { key: "End" });
      expect(search.getAttribute("aria-activedescendant")).toBe(screen.getByRole("option", { name: /UNKNOWN/ }).id);
      expect(scrollIntoView).toHaveBeenLastCalledWith({ block: "nearest" });
      fireEvent.keyDown(search, { key: "Home" });
      expect(search.getAttribute("aria-activedescendant")).toBe(screen.getByRole("option", { name: /BTC, Perpetual/ }).id);
      fireEvent.keyDown(search, { key: "Enter" });
      expect(baseProps.onSelect).toHaveBeenCalledWith(markets[0]);
    } finally {
      if (original === undefined) Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
      else Object.defineProperty(HTMLElement.prototype, "scrollIntoView", original);
    }
  });

  it("restores focus on close and allows tab access to the highlighted favorite action", () => {
    const trigger = document.createElement("button");
    document.body.append(trigger);
    trigger.focus();
    const view = render(<MarketPicker {...baseProps} />);
    const search = screen.getByRole("combobox");
    search.focus();
    fireEvent.keyDown(search, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Add BTC Perpetual to favorites" }));
    fireEvent.keyDown(search, { key: "Escape" });
    expect(baseProps.onClose).toHaveBeenCalledOnce();
    view.unmount();
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });

  it("recovers from malformed storage and keeps favorites usable if storage is denied", () => {
    localStorage.setItem("vex-lighter-analysis", "not-json");
    void useLighterAnalysisStore.persist.rehydrate();
    render(<MarketPicker {...baseProps} />);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("unavailable"); });
    fireEvent.click(screen.getByRole("button", { name: "Add BTC Perpetual to favorites" }));
    expect(screen.getByRole("button", { name: "Remove BTC Perpetual from favorites" })).toBeTruthy();
    expect(screen.getByText(/Favorites are saved for this view only/)).toBeTruthy();
  });

  it("filters verified stock listings without changing their execution product", () => {
    render(<MarketPicker {...baseProps} markets={[makeMarket(19, "BABA", 100), ...markets]} />);
    fireEvent.click(screen.getByRole("button", { name: "Stocks" }));
    expect(screen.getAllByRole("option")).toHaveLength(1);
    expect(screen.getByRole("option", { name: /BABA, Stock · Perpetual/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("option"));
    expect(baseProps.onSelect).toHaveBeenCalledWith(expect.objectContaining({ marketId: 19, marketType: "perp" }));
  });
});
