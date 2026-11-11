import { useEffect, useState, type JSX } from "react";
import type {
  LighterTradingCandleConnectionStatus,
  LighterTradingEnvironment,
  LighterTradingMarket,
  LighterTradingPublicStatsEvent,
  LighterTradingSnapshot,
} from "@shared/schemas/lighter-trading.js";
import { LineChevronDown, LineRefresh } from "../../../components/icons/line/index.js";
import { EnvironmentSwitch } from "./EnvironmentSwitch.js";
import { MarketSymbol } from "./MarketSymbol.js";
import { useTickFlash } from "./useLiveFlash.js";
import { classifyLighterMarket, marketProductLabel } from "./market-classification.js";
import {
  NO_VALUE,
  formatContextTimestamp,
  formatFundingCountdown,
  formatNumber,
  formatPrice,
  formatProviderPercent,
  formatQuoteVolume,
  formatRetrievedAt,
  marketSymbols,
} from "./format.js";

/**
 * THE MARKET BAR in H3 cells (docs/design/H3-DESKTOP.md section 4.9, the
 * owner-approved `lighter-desk` plate, plan row S8-08): one 56 row of cells
 * across the desk, each behind a 1px rule, in this order:
 *
 *   - the MARKET KEY on the cell fill: the market's mark, the ticker (sans
 *     17), the product in muted caps (PERP) and a chevron; it opens the
 *     market picker, which holds Perps, Stocks and Spot;
 *   - CORE | RHC, two key cells: the Lighter deployment the desk trades on.
 *     Both are mainnet: it is never a network menu;
 *   - the LAST PRICE (mono 18) over its day change in gain or loss type;
 *   - the figures, a caps label over a mono value: MARK, INDEX, 24H VOLUME,
 *     OPEN INTEREST, FUNDING / COUNTDOWN for a perp; MID, INDEX and 24H
 *     VOLUME for spot. The bar answers to its own width: under 1100 it sheds
 *     INDEX and 24H VOLUME, under 760 MARK and OPEN INTEREST
 *     (lighter-market-bar.css);
 *   - LIVE at the right end, a status square and the word; off live, the
 *     state word, the time of the last update and the reload key.
 *
 * Mark, index, open interest and funding exist only on the live stats
 * stream: the REST snapshot has no source for them, so while the stream is
 * still connecting they are pending (muted and busy), never "—".
 */
export function MarketBar({
  environment,
  market,
  marketPickerOpen,
  onOpenMarketPicker,
  onSelectEnvironment,
  snapshot,
  liveStats,
  streamStatus,
  streamReceivedAt,
  onReload,
}: {
  readonly environment: LighterTradingEnvironment;
  readonly market: LighterTradingMarket | null;
  readonly marketPickerOpen: boolean;
  readonly onOpenMarketPicker: () => void;
  /** Core | RHC: the deployment the desk trades on (omitted, the cells are not drawn). */
  readonly onSelectEnvironment?: (environment: LighterTradingEnvironment) => void;
  readonly snapshot: LighterTradingSnapshot | null;
  readonly liveStats: LighterTradingPublicStatsEvent["stats"] | null;
  readonly streamStatus: LighterTradingCandleConnectionStatus;
  readonly streamReceivedAt: number | null;
  /** Rebuilds the market streams and re-reads the desk's Lighter data; offered whenever it is not live. */
  readonly onReload?: () => void;
}): JSX.Element {
  const symbols = market === null ? null : marketSymbols(market.symbol, market.marketType);
  const classification = market === null ? null : classifyLighterMarket(environment, market);
  const precision = market?.decimals.price;
  const quoteVolume = liveStats?.daily.quoteTokenVolume
    ?? snapshot?.detail.daily.quoteTokenVolume
    ?? null;
  const fundingTimestamp = liveStats?.funding.timestamp ?? null;
  const statsAsOf = streamReceivedAt ?? snapshot?.retrievedAt ?? null;
  const marketDataLoading = statsAsOf === null
    && (streamStatus === "connecting" || streamStatus === "reconnecting");
  const liveOnlyPending = liveStats === null
    && (streamStatus === "connecting" || streamStatus === "reconnecting");
  const countdown = useFundingCountdown(market?.marketType === "perp");
  return (
    <section
      className="lit-market-bar"
      data-market-type={market?.marketType}
      data-market-section={classification?.section}
      data-loading={marketDataLoading || undefined}
      aria-label="Selected market summary"
      aria-busy={marketDataLoading}
    >
      <MarketSelectKey
        environment={environment}
        market={market}
        open={marketPickerOpen}
        onOpen={onOpenMarketPicker}
      />
      {onSelectEnvironment === undefined ? null : (
        <div className="lit-market-deploy">
          <EnvironmentSwitch environment={environment} onSelect={onSelectEnvironment} />
        </div>
      )}
      <MarketLastPrice market={market} snapshot={snapshot} liveStats={liveStats} />
      {market?.marketType === "spot" ? (
        <>
          <MarketMetric metric="mid" label="Mid" value={formatPrice(liveStats?.midPrice ?? null, precision)} pending={liveOnlyPending} />
          <MarketMetric metric="index" label="Index" value={formatPrice(liveStats?.indexPrice ?? null, precision)} pending={liveOnlyPending} />
          <MarketMetric metric="volume" label="24h volume" value={formatQuoteVolume(quoteVolume, symbols?.quote ?? null)} />
        </>
      ) : (
        <>
          <MarketMetric metric="mark" label="Mark" value={formatPrice(liveStats?.markPrice ?? null, precision)} pending={liveOnlyPending} />
          <MarketMetric metric="index" label="Index" value={formatPrice(liveStats?.indexPrice ?? null, precision)} pending={liveOnlyPending} />
          <MarketMetric metric="volume" label="24h volume" value={formatQuoteVolume(quoteVolume, symbols?.quote ?? "USD")} />
          <MarketMetric metric="open-interest" label="Open interest" value={formatQuoteVolume(liveStats?.openInterestQuote ?? null, "USD")} pending={liveOnlyPending} />
          <MarketMetric
            metric="funding"
            pending={liveOnlyPending}
            label={countdown === null ? "Funding" : "Funding / countdown"}
            value={countdown === null
              ? formatProviderPercent(liveStats?.funding.currentRate ?? null)
              : `${formatProviderPercent(liveStats?.funding.currentRate ?? null)} / ${countdown}`}
            title={fundingTimestamp === null
              ? "Current estimated funding rate, settled every hour"
              : `Current estimated funding rate, settled every hour · provider time ${formatContextTimestamp(fundingTimestamp)}`}
          />
        </>
      )}
      <span
        className="lit-live-status"
        data-status={streamStatus}
        title={statsAsOf === null ? undefined : `Updated ${formatRetrievedAt(statsAsOf)}`}
      >
        <span role="status" aria-live="polite">
          <i aria-hidden="true" /> {streamStatusLabel(streamStatus, market?.symbol)}
        </span>
        {streamStatus === "live" ? null : (
          <>
            {statsAsOf === null ? null : (
              <>
                <span aria-hidden="true">·</span>
                <span>{formatRetrievedAt(statsAsOf)}</span>
              </>
            )}
            {onReload === undefined ? null : (
              <button type="button" className="lit-live-reload" onClick={onReload} aria-label="Reload market data from Lighter" title="Reload from Lighter">
                <LineRefresh size={16} />
              </button>
            )}
          </>
        )}
      </span>
    </section>
  );
}

/**
 * The market key: the market's mark, the ticker, the product in muted caps
 * and a chevron. It opens the market picker. The market bar's first cell,
 * and Zen's (`ZenRow.tsx`).
 */
export function MarketSelectKey({ environment, market, open, onOpen }: {
  readonly environment: LighterTradingEnvironment;
  readonly market: LighterTradingMarket | null;
  readonly open: boolean;
  readonly onOpen: () => void;
}): JSX.Element {
  const classification = market === null ? null : classifyLighterMarket(environment, market);
  // Exchange register: "Perp" beside the ticker, "Perpetual" in the picker.
  const productLabel = classification === null ? null : marketProductLabel(classification).replace(/Perpetual$/, "Perp");
  const product = market === null
    ? "Lighter"
    : [
      market.symbol === classification?.ticker ? null : market.symbol,
      productLabel,
      market.status === "active" ? null : "Inactive",
    ].filter((part): part is string => part !== null).join(" · ");
  return (
    <button
      type="button"
      className="lit-market-select"
      data-lit-market-picker-trigger="true"
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-controls={open ? "lit-market-picker" : undefined}
      onClick={onOpen}
    >
      {market === null ? null : <MarketSymbol environment={environment} market={market} />}
      <b>{classification?.ticker ?? "Select market"}</b>
      <small>{product}</small>
      <LineChevronDown size={14} className="lit-chevron" />
    </button>
  );
}

/**
 * The last price (mono 18) over its day change in gain or loss type, from
 * the live stats first and the snapshot second. The market bar's price
 * cell, and Zen's.
 */
export function MarketLastPrice({ market, snapshot, liveStats }: {
  readonly market: LighterTradingMarket | null;
  readonly snapshot: LighterTradingSnapshot | null;
  readonly liveStats: LighterTradingPublicStatsEvent["stats"] | null;
}): JSX.Element {
  const change = liveStats?.daily.priceChange ?? snapshot?.detail.daily.priceChange ?? null;
  const last = liveStats?.lastTradePrice ?? snapshot?.detail.lastTradePrice ?? null;
  const tone = change === null ? undefined : change >= 0 ? "positive" : "negative";
  const lastFlash = useTickFlash(last);
  const changeText = change === null ? NO_VALUE : `${change >= 0 ? "+" : ""}${formatNumber(change, { maximumFractionDigits: 2, minimumFractionDigits: 2 })}%`;
  return (
    <span className="lit-market-price" data-tone={tone} data-metric="last">
      <b key={lastFlash.tick} data-flash={lastFlash.direction ?? undefined}>{formatPrice(last, market?.decimals.price)}</b>
      <small>{changeText}</small>
    </span>
  );
}

export function streamStatusLabel(
  status: LighterTradingCandleConnectionStatus,
  symbol?: string,
): string {
  switch (status) {
    case "live": return "Live";
    case "connecting": return symbol === undefined ? "Loading market" : `Loading ${symbol}`;
    case "reconnecting": return symbol === undefined ? "Reloading market" : `Reloading ${symbol}`;
    case "delayed": return "Delayed";
    case "unavailable": return "Unavailable";
    case "stopped": return "Waiting";
  }
}

/** One figure cell: its caps label over the mono value. */
function MarketMetric({ metric, label, value, tone, title, pending = false }: {
  readonly metric: string;
  readonly label: string;
  readonly value: string;
  readonly tone?: "positive" | "negative";
  readonly title?: string;
  /** The value is still on its way (stream connecting), not missing. */
  readonly pending?: boolean;
}): JSX.Element {
  return (
    <span
      className="lit-market-metric"
      data-metric={metric}
      data-tone={tone}
      data-pending={pending || undefined}
      aria-busy={pending || undefined}
      title={title}
    >
      <small>{label}</small><b>{value}</b>
    </span>
  );
}

function useFundingCountdown(enabled: boolean): string | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [enabled]);
  return enabled ? formatFundingCountdown(now) : null;
}
