import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { LighterTradingMarket } from "@shared/schemas/lighter-trading.js";
import { MarketBar } from "../MarketBar.js";

const market = {
  marketId: 1,
  symbol: "BTC",
  marketType: "perp",
  status: "active",
  decimals: { price: 1, size: 4 },
} as unknown as LighterTradingMarket;

describe("MarketBar", () => {
  it("names the desk's section in the Perps | Stocks | Spot control and switches on tap", () => {
    const onSelectSection = vi.fn();
    render(
      <MarketBar
        environment="rhc"
        market={market}
        marketPickerOpen={false}
        onOpenMarketPicker={vi.fn()}
        onSelectEnvironment={vi.fn()}
        onSelectSection={onSelectSection}
        snapshot={null}
        liveStats={null}
        streamStatus="live"
        streamReceivedAt={null}
        onAskVex={null}
      />,
    );
    const tabs = screen.getByRole("navigation", { name: "Lighter market category" });
    expect(tabs.textContent).toBe("PerpsStocksSpot");
    expect(screen.getByRole("button", { name: "Perps" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Spot" }).getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "Spot" }));
    expect(onSelectSection).toHaveBeenCalledWith("spot");
  });

  it("offers Ask Vex with its shortcut before the live status once a market is on screen", () => {
    const onAskVex = vi.fn();
    render(
      <MarketBar
        environment="rhc"
        market={market}
        marketPickerOpen={false}
        onOpenMarketPicker={vi.fn()}
        onSelectEnvironment={vi.fn()}
        onSelectSection={vi.fn()}
        snapshot={null}
        liveStats={null}
        streamStatus="live"
        streamReceivedAt={null}
        onAskVex={onAskVex}
      />,
    );
    const trigger = screen.getByRole("button", { name: "Ask Vex" });
    expect(trigger.nextElementSibling).toBe(screen.getByRole("status"));
    fireEvent.click(trigger);
    expect(onAskVex).toHaveBeenCalledTimes(1);
  });

  it("puts the Core | RHC network switch first, ahead of the market select, and switches on tap", () => {
    const onSelectEnvironment = vi.fn();
    render(
      <MarketBar
        environment="core"
        market={market}
        marketPickerOpen={false}
        onOpenMarketPicker={vi.fn()}
        onSelectEnvironment={onSelectEnvironment}
        onSelectSection={vi.fn()}
        snapshot={null}
        liveStats={null}
        streamStatus="live"
        streamReceivedAt={null}
        onAskVex={null}
      />,
    );
    const bar = screen.getByRole("region", { name: "Selected market summary" });
    const group = screen.getByRole("radiogroup", { name: "Lighter environment" });
    expect(bar.firstElementChild).toBe(group);
    expect(group.textContent).toBe("CoreRHC");
    expect(screen.getByRole("radio", { name: "Lighter Core" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("radio", { name: "Lighter Core" }));
    expect(onSelectEnvironment).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("radio", { name: "Robinhood Chain" }));
    expect(onSelectEnvironment).toHaveBeenCalledWith("rhc");
  });
});
