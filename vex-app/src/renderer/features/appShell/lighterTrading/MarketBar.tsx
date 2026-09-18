import { useEffect, useState, type JSX } from "react";
import type {
  LighterTradingCandleConnectionStatus,
  LighterTradingEnvironment,
  LighterTradingMarket,
  LighterTradingPublicStatsEvent,
  LighterTradingSnapshot,
} from "@shared/schemas/lighter-trading.js";
import { IconChevronDown } from "../../../components/icons/index.js";
import { MarketSymbol } from "./MarketSymbol.js";
import { useTickFlash } from "./useLiveFlash.js";
import { classifyLighterMarket, marketProductLabel, type LighterMarketSection } from "./market-classification.js";
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

const SECTIONS: readonly { readonly value: LighterMarketSection; readonly label: string }[] = [
  { value: "perp", label: "Perps" },
  { value: "stocks", label: "Stocks" },
  { value: "spot", label: "Spot" },
];

/** The desk's top strip: market picker trigger, section tabs, last price, live metrics. */
export function MarketBar({
  environment,
  market,
  marketPickerOpen,
  onOpenMarketPicker,
  onSelectSection,
  snapshot,
  liveStats,
  streamStatus,
  streamReceivedAt,
}: {
  readonly environment: LighterTradingEnvironment;
  readonly market: LighterTradingMarket | null;
  readonly marketPickerOpen: boolean;
  readonly onOpenMarketPicker: () => void;
  readonly onSelectSection: (section: LighterMarketSection) => void;
  readonly snapshot: LighterTradingSnapshot | null;
  readonly liveStats: LighterTradingPublicStatsEvent["stats"] | null;
  readonly streamStatus: LighterTradingCandleConnectionStatus;
  readonly streamReceivedAt: number | null;
}): JSX.Element {
  const change = liveStats?.daily.priceChange ?? snapshot?.detail.daily.priceChange ?? null;
  const symbols = market === null ? null : marketSymbols(market.symbol, market.marketType);
  const classification = market === null ? null : classifyLighterMarket(environment, market);
  // Exchange register: "Perp" beside the ticker, "Perpetual" in the picker.
  const productLabel = classification === null ? null : marketProductLabel(classification).replace(/Perpetual$/, "Perp");
  const precision = market?.decimals.price;
  const last = liveStats?.lastTradePrice ?? snapshot?.detail.lastTradePrice ?? null;
  const quoteVolume = liveStats?.daily.quoteTokenVolume
    ?? snapshot?.detail.daily.quoteTokenVolume
    ?? null;
  const high = liveStats?.daily.priceHigh ?? snapshot?.detail.daily.priceHigh ?? null;
  const low = liveStats?.daily.priceLow ?? snapshot?.detail.daily.priceLow ?? null;
  const fundingTimestamp = liveStats?.funding.timestamp ?? null;
  const statsAsOf = streamReceivedAt ?? snapshot?.retrievedAt ?? null;
  const marketDataLoading = statsAsOf === null
    && (streamStatus === "connecting" || streamStatus === "reconnecting");
  // Mark, index, open interest, and funding exist only on the live stats
  // stream: the REST snapshot has no source for them. While the stream is
  // still (re)connecting they are pending, not absent, so they render muted
  // and busy rather than as "—".
  const liveOnlyPending = liveStats === null
    && (streamStatus === "connecting" || streamStatus === "reconnecting");
  const tone = change === null ? undefined : change >= 0 ? "positive" : "negative";
  const lastFlash = useTickFlash(last);
  const changeText = change === null ? NO_VALUE : `${change >= 0 ? "+" : ""}${formatNumber(change, { maximumFractionDigits: 2, minimumFractionDigits: 2 })}%`;
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
      <button
        type="button"
        className="lit-market-select"
        data-lit-market-picker-trigger="true"
        aria-haspopup="dialog"
        aria-expanded={marketPickerOpen}
        aria-controls={marketPickerOpen ? "lit-market-picker" : undefined}
        onClick={onOpenMarketPicker}
      >
        {market === null
          ? <img src="./protocols/lighter.svg" alt="" width="26" height="26" />
          : <MarketSymbol environment={environment} market={market} />}
        <span>
          <b>{classification?.ticker ?? "Select market"}</b>
          <small>
            {market === null
              ? "Lighter"
              : [
                market.symbol === classification?.ticker ? null : market.symbol,
                environment === "rhc" ? "RHC" : "Core",
                productLabel,
                market.status === "active" ? null : "Inactive",
              ].filter((part): part is string => part !== null).join(" · ")}
          </small>
        </span>
        <IconChevronDown size={18} className="lit-chevron" />
      </button>
      <span className="lit-market-price" data-tone={tone} data-metric="last">
        <b key={lastFlash.tick} data-flash={lastFlash.direction ?? undefined}>{formatPrice(last, precision)}</b>
        <small>{changeText}</small>
      </span>
      <div className="lit-market-metrics">
        {market?.marketType === "perp" ? (
          <>
            <MarketMetric metric="mark" label="Mark" value={formatPrice(liveStats?.markPrice ?? null, precision)} pending={liveOnlyPending} />
            <MarketMetric metric="index" label="Index" value={formatPrice(liveStats?.indexPrice ?? null, precision)} pending={liveOnlyPending} />
            <MarketMetric metric="change" label="24h Change" value={changeText} tone={tone} />
            <MarketMetric metric="high" label="24h High" value={formatPrice(high, precision)} />
            <MarketMetric metric="low" label="24h Low" value={formatPrice(low, precision)} />
            <MarketMetric metric="volume" label="24h Volume" value={formatQuoteVolume(quoteVolume, symbols?.quote ?? "USD")} />
            <MarketMetric metric="open-interest" label="Open Interest" value={formatQuoteVolume(liveStats?.openInterestQuote ?? null, "USD")} pending={liveOnlyPending} />
            <MarketMetric
              metric="funding"
              pending={liveOnlyPending}
              label={countdown === null ? "Funding" : "Funding / Countdown"}
              value={countdown === null
                ? formatProviderPercent(liveStats?.funding.currentRate ?? null)
                : `${formatProviderPercent(liveStats?.funding.currentRate ?? null)} / ${countdown}`}
              title={fundingTimestamp === null
                ? "Current estimated funding rate, settled every hour"
                : `Current estimated funding rate, settled every hour · provider time ${formatContextTimestamp(fundingTimestamp)}`}
            />
          </>
        ) : (
          <>
            <MarketMetric metric="index" label="Index" value={formatPrice(liveStats?.indexPrice ?? null, precision)} pending={liveOnlyPending} />
            <MarketMetric metric="mid" label="Mid" value={formatPrice(liveStats?.midPrice ?? null, precision)} pending={liveOnlyPending} />
            <MarketMetric metric="change" label="24h Change" value={changeText} tone={tone} />
            <MarketMetric metric="high" label="24h High" value={formatPrice(high, precision)} />
            <MarketMetric metric="low" label="24h Low" value={formatPrice(low, precision)} />
            <MarketMetric metric="volume" label={`24h Volume (${symbols?.quote ?? "quote"})`} value={formatQuoteVolume(quoteVolume, symbols?.quote ?? null)} />
          </>
        )}
      </div>
      <nav className="lit-category-tabs" aria-label="Lighter market category">
        {SECTIONS.map((section) => (
          <button
            type="button"
            key={section.value}
            aria-pressed={classification?.section === section.value}
            onClick={() => onSelectSection(section.value)}
          >
            {section.label}
          </button>
        ))}
      </nav>
      <span
        className="lit-live-status"
        data-status={streamStatus}
        role="status"
        aria-live="polite"
        title={statsAsOf === null ? undefined : `Updated ${formatRetrievedAt(statsAsOf)}`}
      >
        <i aria-hidden="true" /> {streamStatusLabel(streamStatus, market?.symbol)}
        {statsAsOf === null || streamStatus === "live" ? "" : ` · ${formatRetrievedAt(statsAsOf)}`}
      </span>
    </section>
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
