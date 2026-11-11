/**
 * MARKETS FIXTURES - the watchlist the Markets page reads (`alerts.getWatchlist`)
 * for the install the other states stand in: three followed Base tokens, one
 * up, one down and one the pool cannot price yet, one armed alert set from
 * chat and one that fired this morning. WETH's price is the swap chat's ETH
 * price; the rest are invented and consistent with each other.
 */

import type { PriceAlertDto, WatchlistSnapshotDto } from "@shared/schemas/alerts.js";
import { ok, type BridgeAnswers } from "../bridge.js";
import { HOUR, isoAt, MINUTE } from "../clock.js";
import { fixture } from "../mark.js";

const WETH = "0x4200000000000000000000000000000000000006";
const BRETT = "0x532f27101965dd16442e59d40670faf5ebb142e4";
const DEGEN = "0x4ed4e862860bed51a9570b96d89af5e1b0efefed";

function alert(over: Partial<PriceAlertDto>): PriceAlertDto {
  return {
    id: "6f1c2a4e-8b3d-4c5e-9f10-1a2b3c4d5e6f",
    chain: "base",
    address: WETH,
    assetKey: `base:${WETH}`,
    label: "WETH",
    condition: "above",
    value: "3800",
    referencePrice: "3500.25",
    triggerPrice: "3800",
    direction: "above",
    note: null,
    origin: "chat",
    sessionId: null,
    status: "active",
    triggeredAt: null,
    triggeredPrice: null,
    acknowledgedAt: null,
    createdAt: isoAt(-26 * HOUR),
    ...over,
  };
}

const WATCHLIST: WatchlistSnapshotDto = fixture("watchlist", {
  items: [
    {
      assetKey: `base:${WETH}`,
      chain: "base",
      address: WETH,
      label: "WETH",
      createdAt: isoAt(-30 * HOUR),
      quote: { priceUsd: "3500.25", change24hPct: -1.25, pairAddress: "0xpool-weth", dexId: "uniswap" },
      priceStatus: "priced",
    },
    {
      assetKey: `base:${BRETT}`,
      chain: "base",
      address: BRETT,
      label: "BRETT",
      createdAt: isoAt(-20 * HOUR),
      quote: { priceUsd: "0.004663", change24hPct: 4.82, pairAddress: "0xpool-brett", dexId: "aerodrome" },
      priceStatus: "priced",
    },
    {
      assetKey: `base:${DEGEN}`,
      chain: "base",
      address: DEGEN,
      label: "DEGEN",
      createdAt: isoAt(-3 * MINUTE),
      quote: null,
      priceStatus: "no_price",
    },
  ],
  activeAlerts: [alert({})],
  firedAlerts: [
    alert({
      id: "7a2d3b5f-9c4e-4d6f-8a21-2b3c4d5e6f70",
      address: BRETT,
      assetKey: `base:${BRETT}`,
      label: "BRETT",
      condition: "rises_pct",
      value: "4",
      referencePrice: "0.004448",
      triggerPrice: "0.004626",
      origin: "app",
      status: "triggered",
      triggeredAt: isoAt(-5 * HOUR),
      triggeredPrice: "0.004631",
    }),
  ],
  limits: { watchlist: 50, activeAlerts: 20 },
  pricedAt: isoAt(-20_000),
});

export function marketsAnswers(): BridgeAnswers {
  return { alerts: { getWatchlist: () => ok(WATCHLIST) } };
}
