import { describe, expect, it } from "vitest";

import { filterMarketRows, type HvMarketRow } from "../HypervexingMarketPicker.js";

const row = (coin: string, oi: string | null): HvMarketRow => ({
  coin,
  midPx: "1",
  change24hPct: null,
  openInterestUsd: oi,
});

const ROWS: readonly HvMarketRow[] = [
  row("DOGE", "50"),
  row("BTC", "1000"),
  row("ETH", "400"),
  row("NOOI", null),
];

describe("filterMarketRows", () => {
  it("orders by open interest descending with null OI last", () => {
    expect(filterMarketRows(ROWS, "", "all", []).map((r) => r.coin)).toEqual([
      "BTC",
      "ETH",
      "DOGE",
      "NOOI",
    ]);
  });

  it("search matches case-insensitively on the coin", () => {
    expect(filterMarketRows(ROWS, "et", "all", []).map((r) => r.coin)).toEqual(["ETH"]);
    expect(filterMarketRows(ROWS, "XXX", "all", [])).toEqual([]);
  });

  it("favorites filter keeps only starred coins, still OI-ordered", () => {
    expect(
      filterMarketRows(ROWS, "", "favorites", ["DOGE", "BTC"]).map((r) => r.coin),
    ).toEqual(["BTC", "DOGE"]);
  });

  it("search composes with the favorites filter", () => {
    expect(filterMarketRows(ROWS, "doge", "favorites", ["BTC"])).toEqual([]);
  });
});
