import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { HypervexingMarketPicker, type HvMarketRow } from "../HypervexingMarketPicker.js";

const ROWS: readonly HvMarketRow[] = [
  { coin: "ETH", midPx: "200", change24hPct: "-2", openInterestUsd: "400" },
  { coin: "BTC", midPx: "100", change24hPct: "5", openInterestUsd: "1000" },
];

describe("HypervexingMarketPicker interactions", () => {
  it("keeps OI ordering, filtering, keyboard selection, and close behavior coupled", () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    render(
      <HypervexingMarketPicker
        rows={ROWS}
        favorites={["ETH"]}
        selectedCoin="BTC"
        onToggleFavorite={vi.fn()}
        onSelect={onSelect}
        onClose={onClose}
      />,
    );

    const options = screen.getAllByRole("option");
    expect(options.map((option) => option.textContent)).toEqual([
      expect.stringContaining("BTC-USD"),
      expect.stringContaining("ETH-USD"),
    ]);

    fireEvent.change(screen.getByRole("textbox", { name: "Search markets" }), {
      target: { value: "eth" },
    });
    expect(screen.getAllByRole("option")).toHaveLength(1);
    fireEvent.keyDown(screen.getByRole("dialog", { name: "Select market" }), { key: "Enter" });

    expect(onSelect).toHaveBeenCalledWith("ETH");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("keeps favorite toggling from selecting or closing the row", () => {
    const onToggleFavorite = vi.fn();
    const onSelect = vi.fn();
    const onClose = vi.fn();
    render(
      <HypervexingMarketPicker
        rows={ROWS}
        favorites={[]}
        selectedCoin="BTC"
        onToggleFavorite={onToggleFavorite}
        onSelect={onSelect}
        onClose={onClose}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Star BTC" }));

    expect(onToggleFavorite).toHaveBeenCalledWith("BTC");
    expect(onSelect).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});
