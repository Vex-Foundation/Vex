import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
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
} from "../../../components/icons/index.js";
import {
  useLighterTradingMarkets,
  useLighterTradingSnapshot,
} from "../../../lib/api/lighter-trading.js";
import { useUiStore } from "../../../stores/uiStore.js";
import {
  draftKeyFor,
  readDraft,
  writeDraft,
} from "../../../lib/composer-drafts.js";
import { SessionPanel } from "../SessionPanel.js";
import { MarketChart } from "./MarketChart.js";
import { ChartFullscreenButton } from "./ChartFullscreenButton.js";
import { MarketPicker } from "./MarketPicker.js";
import { OrderBook, type LighterOrderBookData } from "./OrderBook.js";
import { TradingBottomPanel } from "./AccountPanel.js";
import { TradingWorkspace } from "./TradingWorkspace.js";
import {
  buildLighterReviewMessage,
  TradeTicket,
  type TradeDraft,
} from "./TradeTicket.js";
import { MarketSymbol } from "./MarketSymbol.js";
import {
  classifyLighterMarket,
  marketProductLabel,
  marketSectionFor,
  type LighterMarketSection,
} from "./market-classification.js";
import { selectDefaultLighterMarket } from "./market-selection.js";
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
    const next = selectDefaultLighterMarket(category, filteredMarkets);
    setMarketId(next?.marketId ?? null);
  }, [category, filteredMarkets, marketId]);

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
            {market === null ? (
              <WorkspaceLoading label="Choosing a market…" />
            ) : (
              <TradingWorkspace
                hasSession={activeSessionId !== null}
                account={(
                  <TradingBottomPanel
                    trades={publicMarketStream.trades}
                    symbol={symbols?.base ?? market.symbol}
                    environment={environment}
                    open={open}
                    tradesStatus={publicMarketStream.tradesStatus}
                    tradesReceivedAt={publicMarketStream.tradesReceivedAt}
                  />
                )}
              >
                <section className="lit-panel lit-chart-panel" aria-labelledby="lit-chart-title">
                  <header className="lit-panel-header lit-chart-heading">
                    <span className="lit-chart-identity">
                      <h3 id="lit-chart-title">
                        {market.symbol} · {selectedMarketProduct}
                      </h3>
                      <span
                        className="lit-chart-connection"
                        data-status={candleStream.status}
                        title={`Trade-price candles · Updated ${formatRetrievedAt(
                          candleStream.receivedAt
                          ?? snapshot?.retrievedAt
                          ?? marketList.retrievedAt,
                        )}`}
                      >
                        <i aria-hidden="true" />
                        {streamStatusLabel(candleStream.status)}
                      </span>
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
                      <ChartFullscreenButton />
                    </div>
                  </header>
                  <div className="lit-chart-body">
                    <MarketChart
                      candles={candleStream.candles}
                      status={candleStream.status}
                      symbol={market.symbol}
                      theme={theme}
                      environment={environment}
                      marketId={market.marketId}
                      resolution={resolution}
                      pricePrecision={market.decimals.price}
                      priceMinMove={10 ** -market.decimals.price}
                      snapshotFailed={snapshotQuery.isError || snapshotQuery.data?.ok === false}
                      onRetry={() => { void snapshotQuery.refetch(); }}
                      onChooseMarket={() => setMarketPickerOpen(true)}
                    />
                  </div>
                  <footer className="lit-chart-footer">
                    <details className="lit-data-info" onKeyDown={(event) => {
                      if (event.key !== "Escape") return;
                      event.preventDefault();
                      event.stopPropagation();
                      event.currentTarget.open = false;
                      event.currentTarget.querySelector("summary")?.focus();
                    }}>
                      <summary>Market details</summary>
                      <p>
                        Minimum order: {market.minBaseAmount} {symbols?.base ?? market.symbol}.
                        Exchange taker fee: <span>{formatProviderPercent(market.fees.taker, market.fees.takerEnabled)}</span>.
                        Final fees are shown in the order review.
                        Charts use Lighter trade-price candles; hover over the connection status for the last update.
                      </p>
                    </details>
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
                  market={market}
                  book={publicMarketStream.book ?? snapshot?.book ?? EMPTY_BOOK}
                  dataFresh={
                    (snapshot !== null || publicMarketStream.bookReceivedAt !== null)
                    && publicMarketStream.bookStatus !== "delayed"
                    && publicMarketStream.bookStatus !== "unavailable"
                  }
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
              </TradingWorkspace>
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
  market,
  book,
  dataFresh,
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
  readonly market: LighterTradingMarket;
  readonly book: LighterOrderBookData;
  readonly dataFresh: boolean;
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
  const [view, setView] = useState<"desk" | "trade">("desk");
  const [handoffError, setHandoffError] = useState<string | null>(null);
  const [focusComposer, setFocusComposer] = useState(false);
  const panelRef = useRef<HTMLElement | null>(null);
  const marketSymbol = market.symbol;

  useEffect(() => {
    setHandoffError(null);
  }, [market.marketId, view]);

  useEffect(() => {
    if (view !== "desk" || !focusComposer) return;
    panelRef.current
      ?.querySelector<HTMLTextAreaElement>('textarea[aria-label="Session draft"]')
      ?.focus({ preventScroll: true });
    setFocusComposer(false);
  }, [focusComposer, view]);

  const reviewInChat = (draft: TradeDraft): void => {
    const message = buildLighterReviewMessage({ environment, market, draft });
    if (activeSessionId === null) {
      onCreateSession(message);
      return;
    }
    const key = draftKeyFor(activeSessionId);
    if (readDraft(key).trim().length > 0) {
      setHandoffError("Your current chat draft is preserved. Send or clear it before opening this order review.");
      return;
    }
    writeDraft(key, message);
    setHandoffError(null);
    setFocusComposer(true);
    setView("desk");
  };

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
      code: "Chart",
      label: "Mark the chart",
      detail: "Structure, liquidity, key levels, and invalidation",
      message: `${marketContext} Mark the current chart. Identify market structure, liquidity, key levels, and clear invalidation. Separate observed facts from inference. Do not execute anything.`,
    },
    {
      code: "Flow",
      label: "Read the tape",
      detail: "Aggression, absorption, and order-book pressure",
      message: `${marketContext} Read the latest price action, recent trades, and order book. Assess aggression, possible absorption, and order-book pressure. Separate observed facts from inference. Do not execute anything.`,
    },
    {
      code: "Risk",
      label: "Build the play",
      detail: "Entry trigger, stop, targets, and risk-to-reward",
      message: `${marketContext} Help me build a risk-managed trade play. Include the entry trigger, invalidation, stop, targets, risk-to-reward, and position-risk considerations. Do not execute anything.`,
    },
  ] as const;

  return (
    <section
      ref={panelRef}
      className="lit-panel lit-chat-panel"
      aria-labelledby="lit-workspace-panel-title"
    >
      <header className="lit-panel-header lit-chat-heading">
        <span>
          <h3 id="lit-workspace-panel-title">
            {view === "trade"
              ? "Trade ticket"
              : activeSessionId === null ? "Vex trading desk" : "Chat with Vex"}
          </h3>
          <small>
            {view === "trade"
              ? "Preview first · approval stays in chat"
              : activeSessionId === null
              ? "No active session"
              : "Active session · approvals stay in chat"}
          </small>
        </span>
        <div className="lit-panel-view-tabs" role="group" aria-label="Lighter workspace view">
          <button
            type="button"
            id="lit-workspace-desk-tab"
            aria-pressed={view === "desk"}
            aria-controls="lit-workspace-desk-panel"
            onClick={() => setView("desk")}
          >
            Desk
          </button>
          <button
            type="button"
            id="lit-workspace-trade-tab"
            aria-pressed={view === "trade"}
            aria-controls="lit-workspace-trade-panel"
            onClick={() => setView("trade")}
          >
            Trade
          </button>
        </div>
      </header>
      {!open ? null : (
        <>
          <div
            className="lit-workspace-desk"
            role="region"
            id="lit-workspace-desk-panel"
            aria-label="Vex trading desk"
            hidden={view !== "desk"}
          >
            {activeSessionId === null ? (
              <div className="lit-chat-empty">
                <div className="lit-chat-empty-content">
                  <div className="lit-chat-empty-lead">
                    <div className="lit-chat-empty-mark" aria-hidden="true">
                      <img src="./protocols/lighter.svg" alt="" width="44" height="44" />
                    </div>
                    <div className="lit-chat-empty-copy">
                      <h4>Your {marketSymbol} trading desk</h4>
                      <p>
                        Read the chart, explore a setup, or review a trade with Vex.
                      </p>
                    </div>
                  </div>
                  <div className="lit-chat-starters" role="group" aria-label="Trading desk prompts">
                    {prompts.map((prompt) => (
                      <button
                        type="button"
                        key={prompt.label}
                        onClick={() => onCreateSession(prompt.message)}
                      >
                        <span className="lit-chat-starter-code" aria-hidden="true">{prompt.code}</span>
                        <span className="lit-chat-starter-copy">
                          <b>{prompt.label}</b>
                          <small>{prompt.detail}</small>
                        </span>
                        <span className="lit-chat-starter-arrow" aria-hidden="true">
                          <IconArrowUpRight size={17} />
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
                <div className="lit-chat-start-dock">
                  <button type="button" onClick={() => onCreateSession()}>
                    Open the {marketSymbol} desk
                  </button>
                  <small>Read-only until you separately review and approve a trade.</small>
                </div>
              </div>
            ) : (
              <div className="lit-chat-shell">
                <SessionPanel surface="embedded" />
              </div>
            )}
          </div>
          <TradeTicket
            market={market}
            book={book}
            activeSession={activeSessionId !== null}
            dataFresh={dataFresh}
            submitting={false}
            handoffError={handoffError}
            hidden={view !== "trade"}
            onReview={reviewInChat}
          />
        </>
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
  const marketDataLoading = statsAsOf === null
    && (streamStatus === "connecting" || streamStatus === "reconnecting");
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
        <i aria-hidden="true" /> {streamStatusLabel(streamStatus, market?.symbol)}
        {statsAsOf === null ? "" : ` · ${formatRetrievedAt(statsAsOf)}`}
      </span>
    </section>
  );
}

function streamStatusLabel(
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
