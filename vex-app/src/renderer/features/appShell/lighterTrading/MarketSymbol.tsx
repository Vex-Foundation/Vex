import type { JSX } from "react";
import type {
  LighterTradingEnvironment,
  LighterTradingMarket,
} from "@shared/schemas/lighter-trading.js";
import { marketSymbols } from "./format.js";
import { resolveLighterMarketMark } from "./market-marks.js";

/**
 * Shows an offline, identity-bound market mark when one has been reviewed.
 * The complete provider ticker remains the fallback and is also printed by
 * every caller beside this decorative badge.
 */
export function MarketSymbol({ environment, market }: {
  readonly environment: LighterTradingEnvironment;
  readonly market: Pick<
    LighterTradingMarket,
    "baseAssetId" | "marketId" | "symbol" | "marketType"
  >;
}): JSX.Element {
  const symbol = marketSymbols(market.symbol, market.marketType).base;
  const mark = resolveLighterMarketMark(environment, market);
  return (
    <span
      aria-hidden="true"
      className="lit-market-symbol"
      data-market-mark={mark?.kind ?? "ticker"}
      data-symbol-length={mark === null
        ? symbol.length <= 3 ? "short" : symbol.length <= 6 ? "medium" : "long"
        : undefined}
    >
      {mark === null ? symbol : mark.kind === "local" ? (
        <img
          src={mark.src}
          alt=""
          aria-hidden
          width={128}
          height={128}
          draggable={false}
          className="lit-market-symbol-icon"
        />
      ) : (
        <mark.icon
          width="100%"
          height="100%"
          aria-hidden
          focusable={false}
          className="lit-market-symbol-icon"
        />
      )}
    </span>
  );
}
