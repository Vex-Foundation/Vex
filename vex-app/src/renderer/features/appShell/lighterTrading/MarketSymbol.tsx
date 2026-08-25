import { useState, type JSX } from "react";
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
  const [failedLocalMarkSrc, setFailedLocalMarkSrc] = useState<string | null>(null);
  const visibleMark = mark?.kind === "local" && mark.src === failedLocalMarkSrc ? null : mark;
  return (
    <span
      aria-hidden="true"
      className="lit-market-symbol"
      data-market-mark={visibleMark?.kind ?? "ticker"}
      data-symbol-length={visibleMark === null
        ? symbol.length <= 3 ? "short" : symbol.length <= 6 ? "medium" : "long"
        : undefined}
    >
      {visibleMark === null ? symbol : visibleMark.kind === "local" ? (
        <img
          src={visibleMark.src}
          alt=""
          aria-hidden
          width={128}
          height={128}
          draggable={false}
          className="lit-market-symbol-icon"
          onError={() => setFailedLocalMarkSrc(visibleMark.src)}
        />
      ) : (
        <visibleMark.icon
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
