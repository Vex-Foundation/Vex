import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent,
} from "react";
import type {
  LighterTradingCandle,
  LighterTradingCandleConnectionStatus,
  LighterTradingEnvironment,
  LighterTradingLiveResolution,
  LighterTradingMarket,
  LighterTradingPublicStatsEvent,
  LighterTradingSnapshot,
} from "@shared/schemas/lighter-trading.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "../../../components/ui/dialog.js";
import {
  IconArrowUpRight,
  IconChevronDown,
  IconClose,
  IconSearch,
} from "../../../components/icons/index.js";
import {
  useLighterTradingMarkets,
  useLighterTradingSnapshot,
} from "../../../lib/api/lighter-trading.js";
import { useUiStore } from "../../../stores/uiStore.js";
import { SessionPanel } from "../SessionPanel.js";
import { MarketChart } from "./MarketChart.js";
import { OrderBook } from "./OrderBook.js";
import { TradingBottomPanel } from "./AccountPanel.js";
import { MarketSymbol } from "./MarketSymbol.js";
import {
  classifyLighterMarket,
  marketProductLabel,
  marketSectionFor,
  type LighterMarketSection,
} from "./market-classification.js";
import { useLighterCandleStream } from "./useLighterCandleStream.js";
import { useLighterPublicMarketStream } from "./useLighterPublicMarketStream.js";
import {
  formatNumber,
  formatPrice,
  formatProviderPercent,
  formatQuoteVolume,
  formatRetrievedAt,
  marketSymbols,
} from "./format.js";

const RESOLUTIONS: readonly LighterTradingLiveResolution[] = [
  "1m", "5m", "15m", "30m", "1h", "4h", "12h", "1d",
];
const EMPTY_CANDLES: readonly LighterTradingCandle[] = [];
const EMPTY_BOOK: LighterTradingSnapshot["book"] = { asks: [], bids: [] };

export interface LighterTradingDialogProps {
  readonly open: boolean;
  readonly activeSessionId: string | null;
  readonly onOpenChange: (open: boolean) => void;
  readonly onCreateSession: (initialMessage?: string) => void;
}

export function LighterTradingDialog({
  open,
  activeSessionId,
  onOpenChange,
  onCreateSession,
}: LighterTradingDialogProps): JSX.Element {
  const theme = useUiStore((state) => state.theme);
  const [environment, setEnvironment] = useState<LighterTradingEnvironment>("rhc");
  const [category, setCategory] = useState<LighterMarketSection>("perp");
  const [marketId, setMarketId] = useState<number | null>(null);
  const [resolution, setResolution] = useState<LighterTradingLiveResolution>("5m");
  const [marketPickerOpen, setMarketPickerOpen] = useState(false);
  const marketsQuery = useLighterTradingMarkets(environment, open);
  const marketList = marketsQuery.data?.ok === true ? marketsQuery.data.data : null;
  const filteredMarkets = useMemo(() => {
    if (marketList === null) return [];
    return marketList.markets.filter((market) => (
      marketSectionFor(environment, market) === category
    ));
  }, [category, environment, marketList]);

  useEffect(() => {
    const selectedExists = filteredMarkets.some((market) => market.marketId === marketId);
    if (selectedExists) return;
    const next = filteredMarkets.find((market) => (
      market.status === "active" && market.symbol.toLocaleUpperCase() === "BTC"
    ))
      ?? filteredMarkets.find((market) => market.status === "active")
      ?? filteredMarkets[0]
      ?? null;
    setMarketId(next?.marketId ?? null);
  }, [filteredMarkets, marketId]);

  const market = filteredMarkets.find((row) => row.marketId === marketId) ?? null;
  const snapshotQuery = useLighterTradingSnapshot(
    environment,
    marketId,
    resolution,
    open && category !== "stocks",
  );
  const snapshot = snapshotQuery.data?.ok === true ? snapshotQuery.data.data : null;
  const candleStream = useLighterCandleStream({
    enabled: open,
    environment,
    marketId,
    resolution,
    restCandles: snapshot?.candles ?? EMPTY_CANDLES,
  });
  const publicMarketStream = useLighterPublicMarketStream({
    enabled: open,
    environment,
    marketId,
    marketType: market?.marketType ?? null,
    restSnapshot: snapshot,
  });
  const previousPublicStatus = useRef(publicMarketStream.status);
  useEffect(() => {
    const previous = previousPublicStatus.current;
    previousPublicStatus.current = publicMarketStream.status;
    if (
      previous === "live"
      && (publicMarketStream.status === "reconnecting"
        || publicMarketStream.status === "delayed"
        || publicMarketStream.status === "unavailable")
    ) {
      void snapshotQuery.refetch();
    }
  }, [publicMarketStream.status, snapshotQuery.refetch]);
  const symbols = market === null ? null : marketSymbols(market.symbol, market.marketType);
  const marketClassification = market === null
    ? null
    : classifyLighterMarket(environment, market);
  const selectedMarketProduct = marketClassification === null
    ? null
    : marketProductLabel(marketClassification);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="lit-dialog"
        data-vex-area="lighter-trading-dialog"
        data-lighter-theme={theme}
        data-lighter-environment={environment}
      >
        <DialogTitle className="sr-only">Light it up — Lighter trading analysis</DialogTitle>
        <DialogDescription className="sr-only">
          Review live Lighter markets, charts, and order-book depth while chatting with Vex in the active session.
        </DialogDescription>

        <header className="lit-header">
          <div className="lit-brand">
            <img src="./protocols/lighter.svg" alt="" width="32" height="32" />
            <span>
              <b>Light it up</b>
              <small>
                {environment === "rhc"
                  ? "Robinhood Chain · Lighter markets"
                  : "Lighter Core markets"}
              </small>
            </span>
          </div>

          <nav className="lit-category-tabs" aria-label="Lighter market category">
            <button type="button" aria-pressed={category === "perp"} onClick={() => setCategory("perp")}>Perps</button>
            <button
              type="button"
              aria-pressed={category === "stocks"}
              onClick={() => setCategory("stocks")}
            >
              Stocks
            </button>
            <button type="button" aria-pressed={category === "spot"} onClick={() => setCategory("spot")}>Spot</button>
          </nav>

          <div className="lit-header-actions">
            <label className="lit-environment">
              <span className="sr-only">Lighter network</span>
              <span className="lit-environment-mark" aria-hidden="true" />
              <select
                value={environment}
                onChange={(event) => {
                  setMarketPickerOpen(false);
                  setMarketId(null);
                  setEnvironment(event.currentTarget.value as LighterTradingEnvironment);
                }}
              >
                <option value="rhc">Robinhood Chain</option>
                <option value="core">Lighter Core</option>
              </select>
            </label>
            <button
              type="button"
              className="lit-close"
              onClick={() => onOpenChange(false)}
              aria-label="Close Light it up"
            >
              <IconClose size={20} />
            </button>
          </div>
        </header>

        {marketsQuery.data?.ok === false ? (
          <WorkspaceError title="Markets unavailable" message={marketsQuery.data.error.message} />
        ) : marketsQuery.isLoading || marketList === null ? (
          <WorkspaceLoading label="Loading live Lighter markets…" />
        ) : filteredMarkets.length === 0 ? (
          <WorkspaceError title="No markets available" message={`Lighter returned no ${category} markets for this environment.`} />
        ) : (
          <>
            <div className="lit-market-bar-shell">
              <MarketBar
                environment={environment}
                market={market}
                marketPickerOpen={marketPickerOpen}
                onOpenMarketPicker={() => setMarketPickerOpen((current) => !current)}
                snapshot={snapshot}
                liveStats={publicMarketStream.stats}
                streamStatus={publicMarketStream.statsStatus}
                streamReceivedAt={publicMarketStream.statsReceivedAt}
              />
              {marketPickerOpen ? (
                <MarketPicker
                  environment={environment}
                  markets={marketList.markets}
                  selectedMarketId={marketId}
                  onClose={() => setMarketPickerOpen(false)}
                  onSelect={(nextMarket) => {
                    setCategory(marketSectionFor(environment, nextMarket));
                    setMarketId(nextMarket.marketId);
                    setMarketPickerOpen(false);
                  }}
                />
              ) : null}
            </div>
            {market === null || (snapshotQuery.isLoading && candleStream.candles.length === 0) ? (
              <WorkspaceLoading label="Building the live market view…" />
            ) : snapshot === null && candleStream.candles.length === 0 ? (
              <WorkspaceError
                title="Market data unavailable"
                message={snapshotQuery.data?.ok === false
                  ? snapshotQuery.data.error.message
                  : "Lighter has not returned market data yet."}
              />
            ) : (
              <div className="lit-workspace" data-session-active={activeSessionId !== null || undefined}>
                <section className="lit-panel lit-chart-panel" aria-labelledby="lit-chart-title">
                  <header className="lit-panel-header lit-chart-heading">
                    <span>
                      <h3 id="lit-chart-title">
                        {market.symbol} · {selectedMarketProduct}
                      </h3>
                      <small>
                        {candleStream.receivedAt === null
                          ? "Trade-price REST history"
                          : `Trade-price candles · ${streamStatusLabel(candleStream.status)}`}{" "}
                        {formatRetrievedAt(
                          candleStream.receivedAt
                          ?? snapshot?.retrievedAt
                          ?? marketList.retrievedAt,
                        )}
                      </small>
                    </span>
                    <div className="lit-resolution-tabs" aria-label="Chart interval">
                      {RESOLUTIONS.map((item) => (
                        <button
                          type="button"
                          key={item}
                          aria-pressed={resolution === item}
                          onClick={() => setResolution(item)}
                        >
                          {item}
                        </button>
                      ))}
                    </div>
                  </header>
                  <div className="lit-chart-body">
                    <MarketChart
                      candles={candleStream.candles}
                      symbol={market.symbol}
                      theme={theme}
                      environment={environment}
                      marketId={market.marketId}
                      resolution={resolution}
                      pricePrecision={market.decimals.price}
                      priceMinMove={10 ** -market.decimals.price}
                    />
                  </div>
                  <footer className="lit-chart-footer">
                    <span>Trade-price REST history + Lighter trade-candle stream · no simulated points</span>
                    <a href="https://www.tradingview.com/" target="_blank" rel="noopener noreferrer">Charts by TradingView</a>
                  </footer>
                </section>
                <OrderBook
                  book={publicMarketStream.book ?? snapshot?.book ?? EMPTY_BOOK}
                  symbol={symbols?.base ?? market.symbol}
                  status={publicMarketStream.bookStatus}
                  receivedAt={publicMarketStream.bookReceivedAt}
                />
                <LighterConversation
                  open={open}
                  activeSessionId={activeSessionId}
                  marketSymbol={market.symbol}
                  environment={environment}
                  marketId={market.marketId}
                  marketType={market.marketType}
                  resolution={resolution}
                  candleReceivedAt={candleStream.receivedAt}
                  bookReceivedAt={publicMarketStream.bookReceivedAt}
                  statsReceivedAt={publicMarketStream.statsReceivedAt}
                  tradesReceivedAt={publicMarketStream.tradesReceivedAt}
                  onCreateSession={onCreateSession}
                />
                <TradingBottomPanel
                  trades={publicMarketStream.trades}
                  symbol={symbols?.base ?? market.symbol}
                  environment={environment}
                  open={open}
                  tradesStatus={publicMarketStream.tradesStatus}
                  tradesReceivedAt={publicMarketStream.tradesReceivedAt}
                />
              </div>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function LighterConversation({
  open,
  activeSessionId,
  marketSymbol,
  environment,
  marketId,
  marketType,
  resolution,
  candleReceivedAt,
  bookReceivedAt,
  statsReceivedAt,
  tradesReceivedAt,
  onCreateSession,
}: {
  readonly open: boolean;
  readonly activeSessionId: string | null;
  readonly marketSymbol: string;
  readonly environment: LighterTradingEnvironment;
  readonly marketId: number;
  readonly marketType: "perp" | "spot";
  readonly resolution: LighterTradingLiveResolution;
  readonly candleReceivedAt: number | null;
  readonly bookReceivedAt: number | null;
  readonly statsReceivedAt: number | null;
  readonly tradesReceivedAt: number | null;
  readonly onCreateSession: (initialMessage?: string) => void;
}): JSX.Element {
  const marketContext = [
    `Use this exact Lighter scope: environment=${environment}, marketId=${marketId},`,
    `marketType=${marketType}, symbol=${marketSymbol}, candleInterval=${resolution},`,
    "candlePriceBasis=trade.",
    `Observed UI timestamps: candles=${formatContextTimestamp(candleReceivedAt)},`,
    `book=${formatContextTimestamp(bookReceivedAt)}, stats=${formatContextTimestamp(statsReceivedAt)},`,
    `trades=${formatContextTimestamp(tradesReceivedAt)}.`,
    "Refresh official read-only Lighter data for this exact scope before relying on changing values; do not infer the environment or product from the symbol.",
  ].join(" ");
  const prompts = [
    {
      label: "Read the chart",
      detail: "Structure, momentum, and invalidation",
      message: `${marketContext} Analyze the current chart. Identify market structure, momentum, support, resistance, and clear invalidation levels. Do not execute anything.`,
    },
    {
      label: "Explain the move",
      detail: "Price action and order-book context",
      message: `${marketContext} Explain the latest price action using the refreshed Lighter chart and order book. Separate observed facts from inference.`,
    },
    {
      label: "Build a trade plan",
      detail: "Entry, risk, targets, and stop",
      message: `${marketContext} Help me build a risk-managed trade plan. Include entry logic, invalidation, stop, targets, and position-risk considerations. Do not execute anything.`,
    },
  ] as const;

  return (
    <section
      className="lit-panel lit-chat-panel"
      aria-labelledby="lit-chat-title"
    >
      <header className="lit-panel-header lit-chat-heading">
        <span>
          <h3 id="lit-chat-title">Chat with Vex</h3>
          <small>
            {activeSessionId === null
              ? "No active session"
              : "Active session · approvals stay in chat"}
          </small>
        </span>
        <span
          className="lit-chat-live"
          data-active={activeSessionId !== null || undefined}
        >
          <i aria-hidden="true" /> {activeSessionId === null ? "Start session" : "Active"}
        </span>
      </header>
      {!open ? null : activeSessionId === null ? (
        <div className="lit-chat-empty">
          <div className="lit-chat-empty-content">
            <div className="lit-chat-empty-mark" aria-hidden="true">
              <img src="./protocols/lighter.svg" alt="" width="44" height="44" />
            </div>
            <b>Analyze {marketSymbol} without leaving the live tape.</b>
            <p>
              Start a session here and the chart, depth, conversation, and any
              approval card stay together in this workspace.
            </p>
            <div className="lit-chat-starters" aria-label="Suggested market analysis prompts">
              {prompts.map((prompt) => (
                <button
                  type="button"
                  key={prompt.label}
                  onClick={() => onCreateSession(prompt.message)}
                >
                  <span><b>{prompt.label}</b><small>{prompt.detail}</small></span>
                  <span aria-hidden="true"><IconArrowUpRight size={17} /></span>
                </button>
              ))}
            </div>
          </div>
          <div className="lit-chat-start-dock">
            <button type="button" onClick={() => onCreateSession()}>
              Start a Vex session
            </button>
            <small>Read-only until you separately review and approve a trade.</small>
          </div>
        </div>
      ) : (
        <div className="lit-chat-shell">
          <SessionPanel surface="embedded" />
        </div>
      )}
    </section>
  );
}

function MarketBar({
  environment,
  market,
  marketPickerOpen,
  onOpenMarketPicker,
  snapshot,
  liveStats,
  streamStatus,
  streamReceivedAt,
}: {
  readonly environment: LighterTradingEnvironment;
  readonly market: LighterTradingMarket | null;
  readonly marketPickerOpen: boolean;
  readonly onOpenMarketPicker: () => void;
  readonly snapshot: LighterTradingSnapshot | null;
  readonly liveStats: LighterTradingPublicStatsEvent["stats"] | null;
  readonly streamStatus: LighterTradingCandleConnectionStatus;
  readonly streamReceivedAt: number | null;
}): JSX.Element {
  const change = liveStats?.daily.priceChange ?? snapshot?.detail.daily.priceChange ?? null;
  const symbols = market === null ? null : marketSymbols(market.symbol, market.marketType);
  const classification = market === null ? null : classifyLighterMarket(environment, market);
  const precision = market?.decimals.price;
  const last = liveStats?.lastTradePrice ?? snapshot?.detail.lastTradePrice ?? null;
  const quoteVolume = liveStats?.daily.quoteTokenVolume
    ?? snapshot?.detail.daily.quoteTokenVolume
    ?? null;
  const high = liveStats?.daily.priceHigh ?? snapshot?.detail.daily.priceHigh ?? null;
  const low = liveStats?.daily.priceLow ?? snapshot?.detail.daily.priceLow ?? null;
  const fundingTimestamp = liveStats?.funding.timestamp ?? null;
  const statsAsOf = streamReceivedAt ?? snapshot?.retrievedAt ?? null;
  return (
    <section
      className="lit-market-bar"
      data-market-type={market?.marketType}
      data-market-section={classification?.section}
      aria-label="Selected market summary"
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
                classification === null ? null : marketProductLabel(classification),
                market.status,
              ].filter((part): part is string => part !== null).join(" · ")}
          </small>
        </span>
        <IconChevronDown size={18} className="lit-chevron" />
      </button>
      <MarketMetric metric="last" label="Last" value={formatPrice(last, precision)} />
      {market?.marketType === "perp" ? (
        <>
          <MarketMetric metric="mark" label="Mark" value={formatPrice(liveStats?.markPrice ?? null, precision)} />
          <MarketMetric metric="index" label="Index" value={formatPrice(liveStats?.indexPrice ?? null, precision)} />
          <MarketMetric
            metric="change"
            label="24h change"
            value={change === null ? "—" : `${change >= 0 ? "+" : ""}${formatNumber(change)}%`}
            tone={change === null ? undefined : change >= 0 ? "positive" : "negative"}
          />
          <MarketMetric metric="volume" label="24h volume" value={formatQuoteVolume(quoteVolume, symbols?.quote ?? "USD")} />
          <MarketMetric metric="open-interest" label="Open interest (USD)" value={formatQuoteVolume(liveStats?.openInterestQuote ?? null, "USD")} />
          <MarketMetric
            metric="funding"
            label="Funding (current)"
            value={formatProviderPercent(liveStats?.funding.currentRate ?? null)}
            title={fundingTimestamp === null
              ? "Current estimated funding rate"
              : `Current estimated funding rate · provider time ${formatContextTimestamp(fundingTimestamp)}`}
          />
        </>
      ) : (
        <>
          <MarketMetric metric="index" label="Index" value={formatPrice(liveStats?.indexPrice ?? null, precision)} />
          <MarketMetric metric="mid" label="Mid" value={formatPrice(liveStats?.midPrice ?? null, precision)} />
          <MarketMetric
            metric="change"
            label="24h change"
            value={change === null ? "—" : `${change >= 0 ? "+" : ""}${formatNumber(change)}%`}
            tone={change === null ? undefined : change >= 0 ? "positive" : "negative"}
          />
          <MarketMetric metric="high" label="24h high" value={formatPrice(high, precision)} />
          <MarketMetric metric="low" label="24h low" value={formatPrice(low, precision)} />
          <MarketMetric metric="volume" label={`24h volume (${symbols?.quote ?? "quote"})`} value={formatQuoteVolume(quoteVolume, symbols?.quote ?? null)} />
        </>
      )}
      <span
        className="lit-live-status"
        data-status={streamStatus}
        role="status"
        aria-live="polite"
      >
        <i aria-hidden="true" /> {streamStatusLabel(streamStatus)}
        {statsAsOf === null ? "" : ` · ${formatRetrievedAt(statsAsOf)}`}
      </span>
    </section>
  );
}

function streamStatusLabel(status: LighterTradingCandleConnectionStatus): string {
  switch (status) {
    case "live": return "Live";
    case "connecting": return "Connecting";
    case "reconnecting": return "Reconnecting";
    case "delayed": return "Delayed";
    case "unavailable": return "Unavailable";
    case "stopped": return "Waiting";
  }
}

function MarketPicker({
  environment,
  markets,
  selectedMarketId,
  onClose,
  onSelect,
}: {
  readonly environment: LighterTradingEnvironment;
  readonly markets: readonly LighterTradingMarket[];
  readonly selectedMarketId: number | null;
  readonly onClose: () => void;
  readonly onSelect: (market: LighterTradingMarket) => void;
}): JSX.Element {
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<"all" | LighterMarketSection>("all");
  const [highlightedMarketId, setHighlightedMarketId] = useState<number | null>(selectedMarketId);
  const pickerRef = useRef<HTMLElement | null>(null);
  const highlightedOptionRef = useRef<HTMLButtonElement | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(
    document.activeElement instanceof HTMLElement ? document.activeElement : null,
  );
  const shown = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    return markets.filter((market) => {
      const classification = classifyLighterMarket(environment, market);
      return (tab === "all" || classification.section === tab)
        && (
          normalized.length === 0
          || market.symbol.toLocaleLowerCase().includes(normalized)
          || classification.ticker.toLocaleLowerCase().includes(normalized)
        );
    });
  }, [environment, markets, query, tab]);

  useEffect(() => {
    const selectedIsShown = shown.some((market) => market.marketId === selectedMarketId);
    const highlightedIsShown = shown.some((market) => market.marketId === highlightedMarketId);
    if (!highlightedIsShown) {
      setHighlightedMarketId(selectedIsShown ? selectedMarketId : shown[0]?.marketId ?? null);
    }
  }, [highlightedMarketId, selectedMarketId, shown]);

  useEffect(() => {
    highlightedOptionRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [highlightedMarketId]);

  useEffect(() => () => {
    returnFocusRef.current?.focus();
  }, []);

  useEffect(() => {
    const handleOutsideMouseDown = (event: MouseEvent): void => {
      const target = event.target;
      if (!(target instanceof Node) || pickerRef.current?.contains(target)) return;
      if (target instanceof Element && target.closest("[data-lit-market-picker-trigger]")) return;
      onClose();
    };
    document.addEventListener("mousedown", handleOutsideMouseDown);
    return () => document.removeEventListener("mousedown", handleOutsideMouseDown);
  }, [onClose]);

  const moveHighlight = (direction: 1 | -1): void => {
    if (shown.length === 0) return;
    const currentIndex = shown.findIndex((market) => market.marketId === highlightedMarketId);
    const nextIndex = currentIndex < 0
      ? direction === 1 ? 0 : shown.length - 1
      : (currentIndex + direction + shown.length) % shown.length;
    setHighlightedMarketId(shown[nextIndex]!.marketId);
  };

  const handlePickerKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Tab") {
      const focusable = Array.from(pickerRef.current?.querySelectorAll<HTMLElement>(
        "button:not([disabled]):not([tabindex='-1']), input:not([disabled]):not([tabindex='-1']), select:not([disabled]):not([tabindex='-1']), a[href]:not([tabindex='-1'])",
      ) ?? []);
      const first = focusable[0];
      const last = focusable.at(-1);
      if (first !== undefined && last !== undefined) {
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    const isSearchInput = event.target instanceof HTMLInputElement
      && event.target.dataset.litMarketSearch === "true";
    if (isSearchInput && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      event.preventDefault();
      moveHighlight(event.key === "ArrowDown" ? 1 : -1);
      return;
    }
    if (isSearchInput && event.key === "Enter" && highlightedMarketId !== null) {
      const highlighted = shown.find((market) => market.marketId === highlightedMarketId);
      if (highlighted !== undefined) {
        event.preventDefault();
        onSelect(highlighted);
      }
    }
  };

  return (
    <div
      className="lit-market-picker-layer"
      onKeyDown={handlePickerKeyDown}
    >
      <section
        id="lit-market-picker"
        ref={pickerRef}
        className="lit-market-picker"
        role="dialog"
        aria-labelledby="lit-market-picker-title"
      >
        <h2 id="lit-market-picker-title" className="sr-only">Search Lighter markets</h2>
        <div className="lit-market-search">
          <IconSearch size={25} />
          <input
            autoFocus
            role="combobox"
            aria-autocomplete="list"
            aria-controls="lit-market-options"
            aria-expanded="true"
            aria-activedescendant={highlightedMarketId === null ? undefined : `lit-market-${highlightedMarketId}`}
            data-lit-market-search="true"
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder="Search markets"
            aria-label="Search Lighter markets"
          />
          <button type="button" onClick={onClose} aria-label="Close market search"><IconClose size={20} /></button>
        </div>
        <nav className="lit-market-picker-tabs" aria-label="Market type">
          {(["all", "stocks", "perp", "spot"] as const).map((item) => (
            <button
              type="button"
              key={item}
              aria-pressed={tab === item}
              onClick={() => setTab(item)}
            >
              {item === "all"
                ? "All markets"
                : item === "stocks"
                  ? "Stocks"
                  : item === "perp"
                    ? "Perpetuals"
                    : "Spot"}
            </button>
          ))}
          <span>{shown.length} markets</span>
        </nav>
        <div className="lit-market-table-head" aria-hidden="true">
          <span>Market</span><span>Status</span><span>Minimum size</span><span>Minimum value</span><span>Taker fee</span>
        </div>
        <div
          className="lit-market-table"
          id="lit-market-options"
          role="listbox"
          aria-label="Available Lighter markets"
        >
          {shown.length === 0 ? (
            <p>No matching markets.</p>
          ) : shown.map((market) => {
            const symbols = marketSymbols(market.symbol, market.marketType);
            const classification = classifyLighterMarket(environment, market);
            const productLabel = marketProductLabel(classification);
            const takerFee = formatProviderPercent(market.fees.taker, market.fees.takerEnabled);
            const optionLabel = [
              market.symbol,
              productLabel,
              market.status,
              `minimum size ${market.minBaseAmount} ${symbols.base}`,
              `minimum value ${market.minQuoteAmount} ${symbols.quote}`,
              `taker fee ${takerFee}`,
            ].join(", ");
            return <button
              type="button"
              key={market.marketId}
              id={`lit-market-${market.marketId}`}
              role="option"
              tabIndex={-1}
              aria-label={optionLabel}
              aria-selected={market.marketId === selectedMarketId}
              data-highlighted={market.marketId === highlightedMarketId || undefined}
              ref={market.marketId === highlightedMarketId ? highlightedOptionRef : undefined}
              onMouseEnter={() => setHighlightedMarketId(market.marketId)}
              onClick={() => onSelect(market)}
            >
              <span className="lit-market-name">
                <MarketSymbol environment={environment} market={market} />
                <span className="lit-market-identity">
                  <b title={market.symbol}>{market.symbol}</b>
                  <small>{productLabel}</small>
                </span>
              </span>
              <span className="lit-market-status" data-status={market.status}>
                <i aria-hidden="true" />
                <span>{market.status}</span>
              </span>
              <span className="lit-market-value" data-mobile-label="Min size">
                <span>{market.minBaseAmount}</span><small>{symbols.base}</small>
              </span>
              <span className="lit-market-value" data-mobile-label="Min value">
                <span>{market.minQuoteAmount}</span><small>{symbols.quote}</small>
              </span>
              <span className="lit-market-value" data-mobile-label="Taker fee">
                <span>{takerFee}</span>
              </span>
            </button>
          })}
        </div>
        <footer className="lit-market-picker-footer">
          <span><kbd>↑</kbd><kbd>↓</kbd> Navigate</span>
          <span><kbd>Enter</kbd> Select</span>
          <span><kbd>Esc</kbd> Close</span>
        </footer>
      </section>
    </div>
  );
}

function MarketMetric({ metric, label, value, tone, title }: {
  readonly metric: string;
  readonly label: string;
  readonly value: string;
  readonly tone?: "positive" | "negative";
  readonly title?: string;
}): JSX.Element {
  return <span className="lit-market-metric" data-metric={metric} data-tone={tone} title={title}><small>{label}</small><b>{value}</b></span>;
}

function formatContextTimestamp(timestamp: number | null): string {
  if (timestamp === null) return "snapshot/not-yet-streamed";
  const milliseconds = timestamp < 1_000_000_000_000 ? timestamp * 1_000 : timestamp;
  return new Date(milliseconds).toISOString();
}

function WorkspaceLoading({ label }: { readonly label: string }): JSX.Element {
  return <div className="lit-workspace-state" role="status"><span className="lit-loader" aria-hidden="true" />{label}</div>;
}

function WorkspaceError({ title, message }: { readonly title: string; readonly message: string }): JSX.Element {
  return <div className="lit-workspace-state" role="alert"><b>{title}</b><span>{message}</span></div>;
}
