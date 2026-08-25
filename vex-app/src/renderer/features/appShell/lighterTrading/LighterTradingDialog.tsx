import { useEffect, useMemo, useState, type JSX } from "react";
import type {
  LighterTradingEnvironment,
  LighterTradingMarket,
  LighterTradingResolution,
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
import {
  formatCompact,
  formatNumber,
  formatPrice,
  formatRetrievedAt,
} from "./format.js";

const RESOLUTIONS: readonly LighterTradingResolution[] = [
  "1m", "5m", "15m", "30m", "1h", "4h", "12h", "1d", "1w",
];

type MarketCategory = "perp" | "stocks" | "spot";

export interface LighterTradingDialogProps {
  readonly open: boolean;
  readonly activeSessionId: string | null;
  readonly onOpenChange: (open: boolean) => void;
}

export function LighterTradingDialog({
  open,
  activeSessionId,
  onOpenChange,
}: LighterTradingDialogProps): JSX.Element {
  const theme = useUiStore((state) => state.theme);
  const [environment, setEnvironment] = useState<LighterTradingEnvironment>("rhc");
  const [category, setCategory] = useState<MarketCategory>("perp");
  const [marketId, setMarketId] = useState<number | null>(null);
  const [resolution, setResolution] = useState<LighterTradingResolution>("15m");
  const marketsQuery = useLighterTradingMarkets(environment, open);
  const marketList = marketsQuery.data?.ok === true ? marketsQuery.data.data : null;
  const filteredMarkets = useMemo(() => {
    if (marketList === null || category === "stocks") return [];
    return marketList.markets.filter((market) => market.marketType === category);
  }, [category, marketList]);

  useEffect(() => {
    const selectedExists = filteredMarkets.some((market) => market.marketId === marketId);
    if (selectedExists) return;
    const next = filteredMarkets.find((market) => market.status === "active")
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
              markets={filteredMarkets}
              marketId={marketId}
              onMarketChange={setMarketId}
              snapshot={snapshot}
            />
            {snapshotQuery.data?.ok === false ? (
              <WorkspaceError title="Market data unavailable" message={snapshotQuery.data.error.message} />
            ) : snapshotQuery.isLoading || snapshot === null || market === null ? (
              <WorkspaceLoading label="Building the live market view…" />
            ) : (
              <div className="lit-workspace">
                <section className="lit-panel lit-chart-panel" aria-labelledby="lit-chart-title">
                  <header className="lit-panel-header lit-chart-heading">
                    <span>
                      <h3 id="lit-chart-title">{market.symbol} · {market.marketType === "perp" ? "Perpetual" : "Spot"}</h3>
                      <small>Updated {formatRetrievedAt(snapshot.retrievedAt)}</small>
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
                    <MarketChart candles={snapshot.candles} symbol={market.symbol} theme={theme} />
                  </div>
                  <footer className="lit-chart-footer">
                    <span>OHLCV from Lighter · no simulated points</span>
                    <a href="https://www.tradingview.com/" target="_blank" rel="noopener noreferrer">Charts by TradingView</a>
                  </footer>
                </section>
                <OrderBook book={snapshot.book} />
                <LighterConversation open={open} activeSessionId={activeSessionId} />
                <RecentTrades trades={snapshot.trades} />
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
}: {
  readonly open: boolean;
  readonly activeSessionId: string | null;
}): JSX.Element {
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
          <i aria-hidden="true" /> {activeSessionId === null ? "Offline" : "Live"}
        </span>
      </header>
      {!open ? null : activeSessionId === null ? (
        <div className="lit-chat-empty" role="status">
          <img src="./protocols/lighter.svg" alt="" width="42" height="42" />
          <b>Open a session to trade with Vex</b>
          <span>
            The live chart remains available. Close this workspace, start or
            select a session, then return to analyze and chat side by side.
          </span>
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
  markets,
  marketId,
  onMarketChange,
  snapshot,
}: {
  readonly markets: readonly LighterTradingMarket[];
  readonly marketId: number | null;
  readonly onMarketChange: (marketId: number) => void;
  readonly snapshot: LighterTradingSnapshot | null;
}): JSX.Element {
  const change = snapshot?.detail.daily.priceChange ?? null;
  return (
    <section className="lit-market-bar" aria-label="Selected market summary">
      <label className="lit-market-select">
        <span className="sr-only">Selected market</span>
        <select
          value={marketId ?? ""}
          onChange={(event) => onMarketChange(Number(event.currentTarget.value))}
        >
          {markets.map((market) => (
            <option key={market.marketId} value={market.marketId}>
              {market.symbol} · {market.status}
            </option>
          ))}
        </select>
      </label>
      <MarketMetric label="Last" value={formatPrice(snapshot?.detail.lastTradePrice ?? null)} />
      <MarketMetric
        label="24h change"
        value={change === null ? "—" : `${change >= 0 ? "+" : ""}${formatNumber(change)}%`}
        tone={change === null ? undefined : change >= 0 ? "positive" : "negative"}
      />
      <MarketMetric label="24h volume" value={formatCompact(snapshot?.detail.daily.quoteTokenVolume ?? null)} />
      <MarketMetric label="Open interest" value={formatCompact(snapshot?.detail.openInterest ?? null)} />
      <MarketMetric label="Trades" value={formatCompact(snapshot?.detail.daily.tradesCount ?? null)} />
      <span className="lit-live-status" data-stale={snapshot === null || Date.now() - snapshot.retrievedAt > 15_000 || undefined}>
        <i aria-hidden="true" /> {snapshot === null ? "Waiting" : Date.now() - snapshot.retrievedAt > 15_000 ? "Delayed" : "Live"}
      </span>
    </section>
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
