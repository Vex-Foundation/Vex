import type { LighterTradingMarket } from "@shared/schemas/lighter-trading.js";
import type { LighterMarketSection } from "./market-classification.js";

/**
 * Picks a stable initial market without overriding an existing user choice.
 * Spot defaults are provider-ranked by current quote volume so the initial
 * 5-minute window has real trade-price candles instead of simulated points.
 */
export function selectDefaultLighterMarket(
  section: LighterMarketSection,
  markets: readonly LighterTradingMarket[],
): LighterTradingMarket | null {
  const active = markets.filter((market) => market.status === "active");
  if (section === "spot") {
    const liquid = active.filter((market) => (
      market.activity24h.quoteVolume !== null
      && market.activity24h.quoteVolume > 0
    ));
    if (liquid.length > 0) {
      return liquid.reduce((best, candidate) => {
        const volumeDifference = (candidate.activity24h.quoteVolume ?? 0)
          - (best.activity24h.quoteVolume ?? 0);
        if (volumeDifference !== 0) return volumeDifference > 0 ? candidate : best;
        const candidateTrades = candidate.activity24h.tradesCount ?? 0;
        const bestTrades = best.activity24h.tradesCount ?? 0;
        return candidateTrades > bestTrades ? candidate : best;
      });
    }
  }
  return active.find((market) => (
    section === "perp" && market.symbol.toLocaleUpperCase() === "BTC"
  ))
    ?? active[0]
    ?? markets[0]
    ?? null;
}
