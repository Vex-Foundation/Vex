import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MarketSymbol } from "../MarketSymbol.js";

describe("MarketSymbol", () => {
  it("renders the full provider base symbol instead of a first-letter placeholder", () => {
    render(<MarketSymbol market={{ symbol: "1000PEPE", marketType: "perp" }} />);

    const symbol = screen.getByText("1000PEPE");
    expect(symbol.className).toContain("lit-market-symbol");
    expect(symbol.getAttribute("data-symbol-length")).toBe("long");
  });

  it("uses the provider base symbol for pair-form markets", () => {
    render(<MarketSymbol market={{ symbol: "rhSPY/USDC", marketType: "spot" }} />);

    expect(screen.getByText("rhSPY").getAttribute("data-symbol-length")).toBe("medium");
    expect(screen.queryByText("r")).toBeNull();
  });
});
