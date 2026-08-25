import type { JSX } from "react";
import type { LighterTradingMarket } from "@shared/schemas/lighter-trading.js";
import { marketSymbols } from "./format.js";

/**
 * Shows Lighter's provider-supplied base market symbol without substituting
 * an inferred token logo or a first-letter placeholder.
 */
export function MarketSymbol({ market }: {
  readonly market: Pick<LighterTradingMarket, "symbol" | "marketType">;
}): JSX.Element {
  const symbol = marketSymbols(market.symbol, market.marketType).base;
  return (
    <span
      aria-hidden="true"
      className="lit-market-symbol"
      data-symbol-length={symbol.length <= 3 ? "short" : symbol.length <= 6 ? "medium" : "long"}
      title={symbol}
    >
      {symbol}
    </span>
  );
}
