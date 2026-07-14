import { describe, expect, it } from "vitest";

import { extractMarketSnapshot } from "@vex-agent/sync/hyperliquid-reconciler/projections.js";
import { mapHyperliquidMarkets } from "../hyperliquid/market-reads.js";

const SHARED_FIXTURE = [
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

describe("shared Hyperliquid market normalization", () => {
  it("gives IPC reads and reconciliation identical canonical market projections", () => {
    const ipcRows = mapHyperliquidMarkets(SHARED_FIXTURE);
    const reconciliation = extractMarketSnapshot(SHARED_FIXTURE);

    expect(reconciliation.watchlist).toEqual(ipcRows.map((row) => ({
      coin: row.coin,
      midPx: row.markPx,
      change24hPct: row.change24hPct,
      openInterestUsd: row.openInterestUsd,
    })));
    expect([...reconciliation.marks]).toEqual(
      ipcRows.map((row) => [row.coin, row.markPx]),
    );
  });
});
