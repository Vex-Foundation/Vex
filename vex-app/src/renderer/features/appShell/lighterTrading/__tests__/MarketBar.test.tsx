import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { LighterTradingMarket } from "@shared/schemas/lighter-trading.js";
import { MarketBar } from "../MarketBar.js";

const market = {
  marketId: 1,
  symbol: "BTC",
  marketType: "perp",
  status: "active",
  baseAssetId: 1,
  quoteAssetId: 2,
  minBaseAmount: "0.0001",
  minQuoteAmount: "1",
  orderQuoteLimit: "1000000",
  decimals: { price: 1, size: 4, quote: 2 },
  fees: { maker: "0", taker: "0", makerEnabled: true, takerEnabled: true },
  activity24h: { tradesCount: null, quoteVolume: null },
} satisfies LighterTradingMarket;

describe("MarketBar", () => {
  it("names the desk's section in the Perps | Stocks | Spot control and switches on tap", () => {
    const onSelectSection = vi.fn();
    render(
      <MarketBar
        environment="rhc"
        market={market}
        marketPickerOpen={false}
        onOpenMarketPicker={vi.fn()}
        onSelectSection={onSelectSection}
        snapshot={null}
        liveStats={null}
        streamStatus="live"
        streamReceivedAt={null}
      />,
    );
    const tabs = screen.getByRole("navigation", { name: "Lighter market category" });
    expect(tabs.textContent).toBe("PerpsStocksSpot");
    expect(screen.getByRole("button", { name: "Perps" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Spot" }).getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "Spot" }));
    expect(onSelectSection).toHaveBeenCalledWith("spot");
  });

  it("keeps environment switching in the picker and shows only the selected context", () => {
    const onOpenMarketPicker = vi.fn();
    render(
      <MarketBar
        environment="core"
        market={market}
        marketPickerOpen={false}
        onOpenMarketPicker={onOpenMarketPicker}
        onSelectSection={vi.fn()}
        snapshot={null}
        liveStats={null}
        streamStatus="live"
        streamReceivedAt={null}
      />,
    );
    const bar = screen.getByRole("region", { name: "Selected market summary" });
    expect(screen.queryByRole("radiogroup", { name: "Lighter environment" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Ask Vex" })).toBeNull();
    const picker = screen.getByRole("button", { name: /BTC.*Core/ });
    expect(bar.firstElementChild).toBe(picker);
    fireEvent.click(picker);
    expect(onOpenMarketPicker).toHaveBeenCalledOnce();
  });
});
