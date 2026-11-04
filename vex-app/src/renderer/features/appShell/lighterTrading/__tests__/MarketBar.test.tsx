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
  fees: { maker: "0", taker: "0", makerEnabled: true, takerEnabled: true, integratorMaker: null, integratorTaker: null },
  activity24h: { tradesCount: null, quoteVolume: null },
} satisfies LighterTradingMarket;

describe("MarketBar (H3-DESKTOP.md section 4.9)", () => {
  it("is one row of cells in the plate's order, and leaves Perps | Stocks | Spot to the picker", () => {
    render(
      <MarketBar
        environment="core"
        market={market}
        marketPickerOpen={false}
        onOpenMarketPicker={vi.fn()}
        onSelectEnvironment={vi.fn()}
        snapshot={null}
        liveStats={null}
        streamStatus="live"
        streamReceivedAt={null}
      />,
    );
    const bar = screen.getByRole("region", { name: "Selected market summary" });
    const cells = Array.from(bar.children).map((cell) =>
      cell.getAttribute("data-metric") ?? cell.className,
    );
    expect(cells).toEqual([
      "lit-market-select",
      "lit-market-deploy",
      "last",
      "mark",
      "index",
      "volume",
      "open-interest",
      "funding",
      "lit-live-status",
    ]);
    // The figures' labels, words in sentence case (the sheet sets the caps).
    expect(Array.from(bar.querySelectorAll(".lit-market-metric small")).map((label) => label.textContent)).toEqual([
      "Mark",
      "Index",
      "24h volume",
      "Open interest",
      "Funding / countdown",
    ]);
    expect(screen.queryByRole("navigation", { name: "Lighter market category" })).toBeNull();
  });

  it("switches Core and RHC in two key cells, never a network menu", () => {
    const onSelectEnvironment = vi.fn();
    render(
      <MarketBar
        environment="core"
        market={market}
        marketPickerOpen={false}
        onOpenMarketPicker={vi.fn()}
        onSelectEnvironment={onSelectEnvironment}
        snapshot={null}
        liveStats={null}
        streamStatus="live"
        streamReceivedAt={null}
      />,
    );
    const group = screen.getByRole("radiogroup", { name: "Lighter environment" });
    expect(group.closest(".lit-market-deploy")).not.toBeNull();
    expect(screen.getByRole("radio", { name: "Lighter Core" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("radio", { name: "Robinhood Chain" }));
    expect(onSelectEnvironment).toHaveBeenCalledWith("rhc");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("offers a reload next to the time once the market is not live", () => {
    // 2026-09-24: after the Wi-Fi came back the header stayed "Unavailable";
    // the public stream gives up after about two minutes and never rearms.
    const onReload = vi.fn();
    const bar = (streamStatus: "live" | "unavailable") => (
      <MarketBar
        environment="rhc"
        market={market}
        marketPickerOpen={false}
        onOpenMarketPicker={vi.fn()}
        snapshot={null}
        liveStats={null}
        streamStatus={streamStatus}
        streamReceivedAt={1_790_000_000_000}
        onReload={onReload}
      />
    );
    const { rerender } = render(bar("unavailable"));

    const reload = screen.getByRole("button", { name: "Reload market data from Lighter" });
    expect(screen.getByRole("status").textContent).toContain("Unavailable");
    // The reload follows the time the market was last updated.
    expect(reload.previousElementSibling?.textContent).toMatch(/\d/);
    fireEvent.click(reload);
    expect(onReload).toHaveBeenCalledTimes(1);

    rerender(bar("live"));
    expect(screen.queryByRole("button", { name: "Reload market data from Lighter" })).toBeNull();
  });

  it("opens the market picker from the market key, which names the market and its product", () => {
    const onOpenMarketPicker = vi.fn();
    render(
      <MarketBar
        environment="core"
        market={market}
        marketPickerOpen={false}
        onOpenMarketPicker={onOpenMarketPicker}
        snapshot={null}
        liveStats={null}
        streamStatus="live"
        streamReceivedAt={null}
      />,
    );
    const bar = screen.getByRole("region", { name: "Selected market summary" });
    // Without the deployment's handler the bar draws no Core | RHC cells.
    expect(screen.queryByRole("radiogroup", { name: "Lighter environment" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Ask Vex" })).toBeNull();
    const picker = screen.getByRole("button", { name: /BTC.*Perp/ });
    expect(bar.firstElementChild).toBe(picker);
    fireEvent.click(picker);
    expect(onOpenMarketPicker).toHaveBeenCalledOnce();
  });
});
