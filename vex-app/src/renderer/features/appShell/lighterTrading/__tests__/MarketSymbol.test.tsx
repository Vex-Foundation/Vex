import { requireValue } from "../../../../../../../src/__tests__/helpers/require-value.js";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MarketSymbol } from "../MarketSymbol.js";

describe("MarketSymbol", () => {
  it("renders the full provider base symbol when no reviewed market mark exists", () => {
    render(<MarketSymbol environment="core" market={{ baseAssetId: 0, marketId: 4, symbol: "1000PEPE", marketType: "perp" }} />);

    const symbol = screen.getByText("1000PEPE");
    expect(symbol.className).toContain("lit-market-symbol");
    expect(symbol.getAttribute("data-market-mark")).toBe("ticker");
    expect(symbol.getAttribute("data-symbol-length")).toBe("long");
  });

  it("uses the provider base symbol for pair-form markets", () => {
    render(<MarketSymbol environment="core" market={{ baseAssetId: 12, marketId: 2057, symbol: "rhSPY/USDC", marketType: "spot" }} />);

    expect(screen.getByText("rhSPY").getAttribute("data-symbol-length")).toBe("medium");
    expect(screen.queryByText("r")).toBeNull();
  });

  it("renders a bundled brand mark for an exact reviewed provider identity", () => {
    const { container } = render(
      <MarketSymbol environment="rhc" market={{ baseAssetId: 0, marketId: 10, symbol: "AAPL", marketType: "perp" }} />,
    );

    const badge = container.querySelector(".lit-market-symbol");
    expect(badge?.getAttribute("data-market-mark")).toBe("brand");
    expect(badge?.querySelector("svg")).not.toBeNull();
    expect(screen.queryByText("AAPL")).toBeNull();
  });

  it("does not grant a logo to the same ticker on an unreviewed market id", () => {
    render(<MarketSymbol environment="rhc" market={{ baseAssetId: 0, marketId: 999, symbol: "AAPL", marketType: "perp" }} />);

    expect(screen.getByText("AAPL").getAttribute("data-market-mark")).toBe("ticker");
  });

  it("does not grant a logo when the environment or full provider symbol differs", () => {
    const { rerender } = render(
      <MarketSymbol environment="core" market={{ baseAssetId: 0, marketId: 10, symbol: "AAPL", marketType: "perp" }} />,
    );
    expect(screen.getByText("AAPL")).not.toBeNull();

    rerender(
      <MarketSymbol environment="rhc" market={{ baseAssetId: 0, marketId: 10, symbol: "AAPL/USDG", marketType: "spot" }} />,
    );
    expect(screen.getByText("AAPL")).not.toBeNull();
  });

  it("does not grant a logo when the provider base asset id differs", () => {
    render(
      <MarketSymbol environment="rhc" market={{ baseAssetId: 99, marketId: 10, symbol: "AAPL", marketType: "perp" }} />,
    );

    expect(screen.getByText("AAPL").getAttribute("data-market-mark")).toBe("ticker");
  });

  it("renders the bundled official mark for the ANSEM listing", () => {
    const { container } = render(
      <MarketSymbol environment="rhc" market={{ baseAssetId: 0, marketId: 39, symbol: "ANSEM", marketType: "perp" }} />,
    );

    const badge = container.querySelector(".lit-market-symbol");
    expect(badge?.getAttribute("data-market-mark")).toBe("local");
    expect(badge?.querySelector('img[src*="ansem"]')).not.toBeNull();
  });

  it("falls back to the exact provider ticker when a bundled image cannot render", () => {
    const { container } = render(
      <MarketSymbol environment="rhc" market={{ baseAssetId: 0, marketId: 39, symbol: "ANSEM", marketType: "perp" }} />,
    );

    fireEvent.error(requireValue(container.querySelector("img")));

    expect(screen.getByText("ANSEM").getAttribute("data-market-mark")).toBe("ticker");
    expect(container.querySelector("img")).toBeNull();
  });
});
