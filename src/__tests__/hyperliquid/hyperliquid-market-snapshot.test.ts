import { describe, expect, it } from "vitest";

import { parseHyperliquidMarketSnapshot } from "@tools/hyperliquid/market-snapshot.js";

export const SHARED_MARKET_SNAPSHOT_FIXTURE = [
  {
    universe: [
      { name: "BTC", maxLeverage: "50", szDecimals: 5 },
      { name: "ETH", maxLeverage: 25, szDecimals: 4 },
    ],
  },
  [
    {
      markPx: "105.00",
      prevDayPx: "100.00",
      openInterest: "1000.0",
      funding: "0.0010",
      dayNtlVlm: "12345.00",
    },
    {
      markPx: "200.0",
      prevDayPx: null,
      openInterest: "50.00",
      funding: "-0.0020",
      dayNtlVlm: null,
    },
  ],
] as const;

describe("parseHyperliquidMarketSnapshot", () => {
  it("canonicalizes mark, open-interest USD, and 24h change while accepting null prevDayPx", () => {
    expect(parseHyperliquidMarketSnapshot(SHARED_MARKET_SNAPSHOT_FIXTURE)).toEqual([
      {
        coin: "BTC",
        maxLeverage: 50,
        szDecimals: 5,
        markPx: "105",
        change24hPct: "5",
        openInterestUsd: "105000",
        fundingRate8hPct: "0.008",
        dayNtlVlmUsd: "12345",
      },
      {
        coin: "ETH",
        maxLeverage: 25,
        szDecimals: 4,
        markPx: "200",
        change24hPct: null,
        openInterestUsd: "10000",
        fundingRate8hPct: "-0.016",
        dayNtlVlmUsd: null,
      },
    ]);
  });

  it("fails closed when metadata and context lengths diverge", () => {
    expect(() => parseHyperliquidMarketSnapshot([
      { universe: [{ name: "BTC" }] },
      [],
    ])).toThrow(/length/i);
  });
});
