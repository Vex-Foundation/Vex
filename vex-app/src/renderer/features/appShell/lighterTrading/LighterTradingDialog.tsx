import { useEffect, useMemo, useState, type JSX } from "react";
import type {
  LighterTradingCandle,
  LighterTradingCandleConnectionStatus,
  LighterTradingEnvironment,
  LighterTradingLiveResolution,
  LighterTradingMarket,
  LighterTradingSnapshot,
} from "@shared/schemas/lighter-trading.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "../../../components/ui/dialog.js";
import {
  useLighterTradingMarkets,
  useLighterTradingSnapshot,
} from "../../../lib/api/lighter-trading.js";
import { useUiStore } from "../../../stores/uiStore.js";
import { SessionPanel } from "../SessionPanel.js";
import { MarketChart } from "./MarketChart.js";
import { OrderBook } from "./OrderBook.js";
import { useLighterCandleStream } from "./useLighterCandleStream.js";
import {
  formatCompact,
  formatNumber,
  formatPrice,
  formatRetrievedAt,
} from "./format.js";

const RESOLUTIONS: readonly LighterTradingLiveResolution[] = [
  "1m", "5m", "15m", "30m", "1h", "4h", "12h", "1d",
];
const EMPTY_CANDLES: readonly LighterTradingCandle[] = [];
const EMPTY_BOOK: LighterTradingSnapshot["book"] = { asks: [], bids: [] };
const EMPTY_TRADES: LighterTradingSnapshot["trades"] = [];

type MarketCategory = "perp" | "stocks" | "spot";

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
  const [category, setCategory] = useState<MarketCategory>("perp");
  const [marketId, setMarketId] = useState<number | null>(null);
  const [resolution, setResolution] = useState<LighterTradingLiveResolution>("5m");
  const [marketPickerOpen, setMarketPickerOpen] = useState(false);
  const marketsQuery = useLighterTradingMarkets(environment, open);
  const marketList = marketsQuery.data?.ok === true ? marketsQuery.data.data : null;
  const filteredMarkets = useMemo(() => {
    if (marketList === null || category === "stocks") return [];
    return marketList.markets.filter((market) => market.marketType === category);
  }, [category, marketList]);

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
    enabled: open && category !== "stocks",
    environment,
    marketId,
    resolution,
    restCandles: snapshot?.candles ?? EMPTY_CANDLES,
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="lit-dialog"
        data-vex-area="lighter-trading-dialog"
        data-lighter-theme={theme}
      >
        <DialogTitle className="sr-only">Light it up — Lighter trading analysis</DialogTitle>
        <DialogDescription className="sr-only">
          Review live Lighter markets, charts, and order-book depth while chatting with Vex in the active session.
        </DialogDescription>

        <header className="lit-header">
          <div className="lit-brand">
            <img src="./protocols/lighter.svg" alt="" width="32" height="32" />
            <span><b>Light it up</b><small>Lighter market data</small></span>
          </div>

          <nav className="lit-category-tabs" aria-label="Lighter market category">
            <button type="button" aria-pressed={category === "perp"} onClick={() => setCategory("perp")}>Perps</button>
            <button
              type="button"
              disabled
              aria-disabled="true"
              title="Provider classification unavailable"
            >
              Stocks <small>Unavailable</small>
            </button>
            <button type="button" aria-pressed={category === "spot"} onClick={() => setCategory("spot")}>Spot</button>
          </nav>

          <div className="lit-header-actions">
            <label className="lit-environment">
              <span className="sr-only">Lighter environment</span>
              <select
                value={environment}
                onChange={(event) => setEnvironment(event.currentTarget.value as LighterTradingEnvironment)}
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
              ×
            </button>
          </div>
        </header>

        {category === "stocks" ? (
          <UnavailableStocks />
        ) : marketsQuery.data?.ok === false ? (
          <WorkspaceError title="Markets unavailable" message={marketsQuery.data.error.message} />
        ) : marketsQuery.isLoading || marketList === null ? (
          <WorkspaceLoading label="Loading live Lighter markets…" />
        ) : filteredMarkets.length === 0 ? (
          <WorkspaceError title="No markets available" message={`Lighter returned no ${category} markets for this environment.`} />
        ) : (
          <>
            <MarketBar
              market={market}
              onOpenMarketPicker={() => setMarketPickerOpen(true)}
              snapshot={snapshot}
              streamStatus={candleStream.status}
            />
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
                      <h3 id="lit-chart-title">{market.symbol} · {market.marketType === "perp" ? "Perpetual" : "Spot"}</h3>
                      <small>
                        {candleStream.receivedAt === null ? "Snapshot" : "Candle feed"}{" "}
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
                    <span>REST history + Lighter candle stream · no simulated points</span>
                    <a href="https://www.tradingview.com/" target="_blank" rel="noopener noreferrer">Charts by TradingView</a>
                  </footer>
                </section>
                <OrderBook book={snapshot?.book ?? EMPTY_BOOK} />
                <LighterConversation
                  open={open}
                  activeSessionId={activeSessionId}
                  marketSymbol={market.symbol}
                  onCreateSession={onCreateSession}
                />
                <RecentTrades trades={snapshot?.trades ?? EMPTY_TRADES} />
              </div>
            )}
            {marketPickerOpen ? (
              <MarketPicker
                markets={marketList.markets}
                selectedMarketId={marketId}
                onClose={() => setMarketPickerOpen(false)}
                onSelect={(nextMarket) => {
                  setCategory(nextMarket.marketType);
                  setMarketId(nextMarket.marketId);
                  setMarketPickerOpen(false);
                }}
              />
            ) : null}
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
  onCreateSession,
}: {
  readonly open: boolean;
  readonly activeSessionId: string | null;
  readonly marketSymbol: string;
  readonly onCreateSession: (initialMessage?: string) => void;
}): JSX.Element {
  const prompts = [
    {
      label: "Read the chart",
      detail: "Structure, momentum, and invalidation",
      message: `Analyze the current ${marketSymbol} Lighter chart. Identify market structure, momentum, support, resistance, and clear invalidation levels. Do not execute anything.`,
    },
    {
      label: "Explain the move",
      detail: "Price action and order-book context",
      message: `Explain the latest ${marketSymbol} price action using the live Lighter chart and order book. Separate observed facts from inference.`,
    },
    {
      label: "Build a trade plan",
      detail: "Entry, risk, targets, and stop",
      message: `Help me build a risk-managed ${marketSymbol} trade plan from the live Lighter market. Include entry logic, invalidation, stop, targets, and position-risk considerations. Do not execute anything.`,
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
          <i aria-hidden="true" /> {activeSessionId === null ? "Start session" : "Live"}
        </span>
      </header>
      {!open ? null : activeSessionId === null ? (
        <div className="lit-chat-empty">
          <div className="lit-chat-empty-content">
            <div className="lit-chat-empty-mark" aria-hidden="true">
              <img src="./protocols/lighter.svg" alt="" width="44" height="44" />
            </div>
            <small>VEX MARKET COPILOT</small>
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
                  <span aria-hidden="true">↗</span>
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
  market,
  onOpenMarketPicker,
  snapshot,
  streamStatus,
}: {
  readonly market: LighterTradingMarket | null;
  readonly onOpenMarketPicker: () => void;
  readonly snapshot: LighterTradingSnapshot | null;
  readonly streamStatus: LighterTradingCandleConnectionStatus;
}): JSX.Element {
  const change = snapshot?.detail.daily.priceChange ?? null;
  return (
    <section className="lit-market-bar" aria-label="Selected market summary">
      <button
        type="button"
        className="lit-market-select"
        aria-haspopup="dialog"
        onClick={onOpenMarketPicker}
      >
        <img src="./protocols/lighter.svg" alt="" width="26" height="26" />
        <span><b>{market?.symbol ?? "Select market"}</b><small>{market === null ? "Lighter" : `${market.marketType} · ${market.status}`}</small></span>
        <span aria-hidden="true">⌄</span>
      </button>
      <MarketMetric label="Last" value={formatPrice(snapshot?.detail.lastTradePrice ?? null)} />
      <MarketMetric
        label="24h change"
        value={change === null ? "—" : `${change >= 0 ? "+" : ""}${formatNumber(change)}%`}
        tone={change === null ? undefined : change >= 0 ? "positive" : "negative"}
      />
      <MarketMetric label="24h volume" value={formatCompact(snapshot?.detail.daily.quoteTokenVolume ?? null)} />
      <MarketMetric label="Open interest" value={formatCompact(snapshot?.detail.openInterest ?? null)} />
      <MarketMetric label="Trades" value={formatCompact(snapshot?.detail.daily.tradesCount ?? null)} />
      <span className="lit-live-status" data-stale={streamStatus !== "live" || undefined}>
        <i aria-hidden="true" /> {streamStatusLabel(streamStatus)}
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
  markets,
  selectedMarketId,
  onClose,
  onSelect,
}: {
  readonly markets: readonly LighterTradingMarket[];
  readonly selectedMarketId: number | null;
  readonly onClose: () => void;
  readonly onSelect: (market: LighterTradingMarket) => void;
}): JSX.Element {
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<"all" | "perp" | "spot">("all");
  const shown = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    return markets.filter((market) => (
      (tab === "all" || market.marketType === tab)
      && (normalized.length === 0 || market.symbol.toLocaleLowerCase().includes(normalized))
    ));
  }, [markets, query, tab]);

  return (
    <div
      className="lit-market-picker-backdrop"
      onKeyDown={(event) => {
        if (event.key === "Escape") onClose();
      }}
    >
      <section
        className="lit-market-picker"
        role="dialog"
        aria-modal="true"
        aria-labelledby="lit-market-picker-title"
      >
        <h2 id="lit-market-picker-title" className="sr-only">Search Lighter markets</h2>
        <div className="lit-market-search">
          <span aria-hidden="true">⌕</span>
          <input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder="Search markets"
            aria-label="Search Lighter markets"
          />
          <button type="button" onClick={onClose} aria-label="Close market search">×</button>
        </div>
        <nav className="lit-market-picker-tabs" aria-label="Market type">
          {(["all", "perp", "spot"] as const).map((item) => (
            <button
              type="button"
              key={item}
              aria-pressed={tab === item}
              onClick={() => setTab(item)}
            >
              {item === "all" ? "All markets" : item === "perp" ? "Perpetuals" : "Spot"}
            </button>
          ))}
          <span>{shown.length} markets</span>
        </nav>
        <div className="lit-market-table-head" aria-hidden="true">
          <span>Market</span><span>Type</span><span>Status</span><span>Minimum size</span><span>Taker fee</span>
        </div>
        <div className="lit-market-table" role="listbox" aria-label="Available Lighter markets">
          {shown.length === 0 ? (
            <p>No matching markets.</p>
          ) : shown.map((market) => (
            <button
              type="button"
              key={market.marketId}
              role="option"
              aria-selected={market.marketId === selectedMarketId}
              onClick={() => onSelect(market)}
            >
              <span className="lit-market-name"><i aria-hidden="true">{market.symbol.slice(0, 1)}</i><b>{market.symbol}</b></span>
              <span>{market.marketType === "perp" ? "Perpetual" : "Spot"}</span>
              <span data-status={market.status}>{market.status}</span>
              <span>{market.minBaseAmount}</span>
              <span>{formatNumber(Number(market.fees.taker) * 100)}%</span>
            </button>
          ))}
        </div>
        <footer className="lit-market-picker-footer"><span>↑↓ Navigate</span><span>Enter Select</span><span>Esc Close</span></footer>
      </section>
    </div>
  );
}

function MarketMetric({ label, value, tone }: {
  readonly label: string;
  readonly value: string;
  readonly tone?: "positive" | "negative";
}): JSX.Element {
  return <span className="lit-market-metric" data-tone={tone}><small>{label}</small><b>{value}</b></span>;
}

function RecentTrades({ trades }: {
  readonly trades: LighterTradingSnapshot["trades"];
}): JSX.Element {
  return (
    <section className="lit-panel lit-recent-trades" aria-labelledby="lit-trades-title">
      <header className="lit-panel-header"><h3 id="lit-trades-title">Recent trades</h3><span>Live provider tape</span></header>
      {trades.length === 0 ? (
        <p className="lit-book-empty">No recent trades returned.</p>
      ) : (
        <>
          <div className="lit-trades-columns" aria-hidden="true"><span>Side</span><span>Price</span><span>Size</span><span>Time</span></div>
          <div className="lit-trades-list">
            {trades.slice(0, 12).map((trade) => (
              <div key={trade.tradeId} data-side={trade.takerSide}>
                <span>{trade.takerSide === "buy" ? "Buy" : "Sell"}</span>
                <b>{trade.price}</b>
                <span>{trade.size}</span>
                <time dateTime={new Date(trade.timestamp >= 1_000_000_000_000 ? trade.timestamp : trade.timestamp * 1_000).toISOString()}>
                  {formatRetrievedAt(trade.timestamp >= 1_000_000_000_000 ? trade.timestamp : trade.timestamp * 1_000)}
                </time>
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

function WorkspaceLoading({ label }: { readonly label: string }): JSX.Element {
  return <div className="lit-workspace-state" role="status"><span className="lit-loader" aria-hidden="true" />{label}</div>;
}

function WorkspaceError({ title, message }: { readonly title: string; readonly message: string }): JSX.Element {
  return <div className="lit-workspace-state" role="alert"><b>{title}</b><span>{message}</span></div>;
}

function UnavailableStocks(): JSX.Element {
  return (
    <div className="lit-workspace-state lit-stocks-unavailable" role="status">
      <img src="./protocols/lighter.svg" alt="" width="52" height="52" />
      <b>Stock classification is unavailable</b>
      <span>Lighter currently identifies these markets only as perpetual or spot. Light it up will not infer stock products from ticker names.</span>
      <small>Perpetual and spot analysis remain available.</small>
    </div>
  );
}
