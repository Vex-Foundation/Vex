import { useEffect, useMemo, useRef, useState, type CSSProperties, type JSX, type MouseEvent, type ReactNode } from "react";
import type {
  LighterTradingCandleConnectionStatus,
  LighterTradingSnapshot,
} from "@shared/schemas/lighter-trading.js";
import {
  GROUP_MULTIPLIERS,
  bookInside,
  groupTickLabel,
  groupedLevels,
  type BookLevel,
  type BookSide,
  type LighterOrderBookData,
} from "./book-model.js";
import { NO_VALUE, formatDecimalString, formatNumber } from "./format.js";
import type { TradeTicketPricePick } from "./ticket-model.js";
import { useLevelTicks, useNewIds } from "./useLiveFlash.js";

export type { LighterOrderBookData } from "./book-model.js";

/** `stack`: asks over the inside row over bids with a cumulative Sum column; `split`: bids beside asks. */
type BookView = "stack" | "split";
type SizeUnit = "base" | "quote";
type PriceSelect = (price: string, kind: TradeTicketPricePick["kind"]) => void;

const TRADES_LIMIT = 40;

function sizeLabel(size: string, price: string, unit: SizeUnit): string {
  if (unit === "base") return formatDecimalString(size);
  const quote = Number(size) * Number(price);
  return formatNumber(quote, { maximumFractionDigits: quote >= 1_000 ? 0 : 2 });
}

function tradeTime(timestamp: number): string {
  const millis = timestamp >= 1_000_000_000_000 ? timestamp : timestamp * 1_000;
  const date = new Date(millis);
  if (!Number.isFinite(date.getTime())) return NO_VALUE;
  return new Intl.DateTimeFormat("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(date);
}

/** Shift-click loads the price as a protection trigger instead of a limit price. */
const pickKind = (event: MouseEvent): TradeTicketPricePick["kind"] => event.shiftKey ? "trigger" : "limit";

function BookColumn({ levels, side, unit, maxTotal, view, onPriceSelect }: {
  readonly levels: readonly BookLevel[];
  readonly side: BookSide;
  readonly unit: SizeUnit;
  readonly maxTotal: number;
  readonly view: BookView;
  readonly onPriceSelect: PriceSelect;
}): JSX.Element {
  const ticks = useLevelTicks(levels);
  // Stacked, the asks read far to best downward so the inside meets the mid row.
  const rows = view === "stack" && side === "ask" ? [...levels].reverse() : levels;
  return (
    <div className="lit-book-rows" data-side={side}>
      {rows.map((level) => {
        const depth = maxTotal > 0 ? Math.min(100, (Number(level.total) / maxTotal) * 100) : 0;
        const tick = ticks.get(level.price) ?? 0;
        return (
          <button
            type="button"
            // A changed size remounts the row, which replays its flash.
            key={`${level.price}:${String(tick)}`}
            className="lit-book-row"
            data-flash={tick > 0 ? "" : undefined}
            style={{ "--lit-depth": `${depth}%` } as CSSProperties}
            onClick={(event) => onPriceSelect(level.price, pickKind(event))}
            title={`Total ${sizeLabel(level.total, level.price, unit)} · shift-click for a trigger`}
            aria-label={`${side === "ask" ? "Ask" : "Bid"} ${level.price}, size ${level.size}, total ${level.total}`}
          >
            <b>{formatDecimalString(level.price)}</b>
            <span>{sizeLabel(level.size, level.price, unit)}</span>
            {view === "stack" ? <span>{sizeLabel(level.total, level.price, unit)}</span> : null}
          </button>
        );
      })}
    </div>
  );
}

export function MarketBookPanel({
  splitter,
  heading,
  book,
  baseSymbol,
  quoteSymbol,
  priceDecimals,
  lastPrice,
  markPrice,
  bookStatus,
  onPriceSelect,
}: {
  /** The seam beside the book, rendered inside so it sits on the panel's edge. */
  readonly splitter?: ReactNode;
  /** Replaces the panel's title, e.g. the book/trades tabs when the column is stacked. */
  readonly heading?: ReactNode;
  readonly book: LighterOrderBookData;
  readonly baseSymbol: string;
  readonly quoteSymbol: string;
  readonly priceDecimals: number;
  readonly lastPrice: number | null;
  readonly markPrice: number | null;
  readonly bookStatus: LighterTradingCandleConnectionStatus;
  readonly onPriceSelect: PriceSelect;
}): JSX.Element {
  const [view, setView] = useState<BookView>("stack");
  const [unit, setUnit] = useState<SizeUnit>("base");
  const [multiplier, setMultiplier] = useState<number>(1);
  const previousLast = useRef<number | null>(null);
  const [trend, setTrend] = useState<"up" | "down" | null>(null);

  useEffect(() => {
    // A market switch passes through null (REST snapshot and stream stats both
    // reset); forgetting the old market's price keeps its trend from bleeding
    // into the new one's first tick.
    if (lastPrice === null) {
      previousLast.current = null;
      setTrend(null);
      return;
    }
    const previous = previousLast.current;
    previousLast.current = lastPrice;
    if (previous === null || previous === lastPrice) return;
    setTrend(lastPrice > previous ? "up" : "down");
  }, [lastPrice]);

  const { asks, bids, maxTotal, bidShare, inside } = useMemo(() => {
    const askLevels = groupedLevels(book.asks, "ask", priceDecimals, multiplier);
    const bidLevels = groupedLevels(book.bids, "bid", priceDecimals, multiplier);
    const askTotal = Number(askLevels.at(-1)?.total ?? 0);
    const bidTotal = Number(bidLevels.at(-1)?.total ?? 0);
    return {
      asks: askLevels,
      bids: bidLevels,
      maxTotal: Math.max(askTotal, bidTotal),
      bidShare: askTotal + bidTotal > 0 ? (bidTotal / (askTotal + bidTotal)) * 100 : null,
      inside: bookInside(book),
    };
  }, [book, multiplier, priceDecimals]);

  const priceDigits = { minimumFractionDigits: Math.min(priceDecimals, 2), maximumFractionDigits: priceDecimals };
  const empty = asks.length === 0 && bids.length === 0;
  const unitSymbol = unit === "base" ? baseSymbol : quoteSymbol;
  const column = (side: BookSide): JSX.Element => (
    <BookColumn
      levels={side === "ask" ? asks : bids}
      side={side}
      unit={unit}
      maxTotal={maxTotal}
      view={view}
      onPriceSelect={onPriceSelect}
    />
  );
  const spreadLabel =
    inside.spread === null
      ? "Spread --"
      : `Spread ${formatDecimalString(inside.spread)}${inside.spreadBps === null ? "" : ` (${formatNumber(inside.spreadBps, { maximumFractionDigits: 1 })} bp)`}`;
  // The row carries the spread as its title too: at the column's floor the
  // words give way to the mark (lighter-book.css) and the hover still says it.
  const mid = (
    <div className="lit-book-mid" data-trend={trend ?? undefined} title={spreadLabel}>
      <b>{lastPrice === null ? NO_VALUE : formatNumber(lastPrice, priceDigits)}</b>
      <span>{spreadLabel}</span>
      <span>{markPrice === null ? "Mark --" : `Mark ${formatNumber(markPrice, priceDigits)}`}</span>
    </div>
  );

  return (
    <section className="lit-panel lit-book-panel" aria-label="Order book" data-view={view}>
      {splitter}
      <header className="lit-panel-header lit-book-header">
        {heading ?? <h3>Order Book</h3>}
        <div className="lit-book-controls">
          <div className="lit-unit-switch" role="group" aria-label="Size unit">
            <button type="button" aria-pressed={unit === "base"} onClick={() => setUnit("base")}>{baseSymbol}</button>
            <button type="button" aria-pressed={unit === "quote"} onClick={() => setUnit("quote")}>{quoteSymbol}</button>
          </div>
          <div className="lit-unit-switch lit-view-switch" role="group" aria-label="Book view">
            <button type="button" aria-pressed={view === "stack"} aria-label="Stacked" title="Asks over bids" onClick={() => setView("stack")}>
              <svg viewBox="0 0 12 12" aria-hidden="true"><rect x="1.5" y="1.5" width="9" height="3.5" /><rect x="1.5" y="7" width="9" height="3.5" /></svg>
            </button>
            <button type="button" aria-pressed={view === "split"} aria-label="Side by side" title="Bids beside asks" onClick={() => setView("split")}>
              <svg viewBox="0 0 12 12" aria-hidden="true"><rect x="1.5" y="1.5" width="3.5" height="9" /><rect x="7" y="1.5" width="3.5" height="9" /></svg>
            </button>
          </div>
        </div>
        <span className="lit-live-dot" data-status={bookStatus} title={`Book: ${bookStatus}`} aria-label={`Book ${bookStatus}`} />
      </header>
      <div className="lit-book-labels">
        <div className="lit-book-columns" data-view={view}>
        {view === "stack" ? (
          <>
            <span aria-hidden="true">Price ({quoteSymbol})</span>
            <span aria-hidden="true">Size ({unitSymbol})</span>
            {/* The sum is in the size unit; the label stays bare so three columns fit the 220px floor. */}
            <span aria-hidden="true">Sum</span>
          </>
        ) : (
          <>
            <span aria-hidden="true">Size</span>
            <span aria-hidden="true">Bid</span>
            <span aria-hidden="true">Ask</span>
            <span aria-hidden="true">Size</span>
          </>
        )}
        </div>
        <select
          aria-label="Price grouping"
          value={multiplier}
          onChange={(event) => setMultiplier(Number(event.currentTarget.value))}
        >
          {GROUP_MULTIPLIERS.map((item) => (
            <option key={item} value={item}>{groupTickLabel(item, priceDecimals)}</option>
          ))}
        </select>
      </div>
      {view === "stack" ? (
        <div className="lit-book-stack">
          {empty ? <p className="lit-book-empty">No order book levels yet.</p> : column("ask")}
          {mid}
          {empty ? null : column("bid")}
        </div>
      ) : (
        <>
          {mid}
          <div className="lit-book-body">
            {empty ? <p className="lit-book-empty">No order book levels yet.</p> : <>{column("bid")}{column("ask")}</>}
          </div>
        </>
      )}
      <div className="lit-book-ratio" aria-label={bidShare === null ? "Bid and ask depth unavailable" : `Bids ${formatNumber(bidShare, { maximumFractionDigits: 0 })}% of visible depth`}>
        <span data-side="bid">B {bidShare === null ? NO_VALUE : `${formatNumber(bidShare, { maximumFractionDigits: 0 })}%`}</span>
        <i style={{ "--lit-bid-share": `${bidShare ?? 50}%` } as CSSProperties} />
        <span data-side="ask">{bidShare === null ? NO_VALUE : `${formatNumber(100 - bidShare, { maximumFractionDigits: 0 })}%`} S</span>
      </div>
    </section>
  );
}

/** The tape under the book: its own panel, so it never hides behind a tab. */
export function TradesPanel({ splitter, heading, trades, baseSymbol, tradesStatus, onPriceSelect }: {
  /** The seam above the trades, rendered inside so it sits on the panel's top edge. */
  readonly splitter?: ReactNode;
  readonly heading?: ReactNode;
  readonly trades: LighterTradingSnapshot["trades"];
  readonly baseSymbol: string;
  readonly tradesStatus: LighterTradingCandleConnectionStatus;
  readonly onPriceSelect: PriceSelect;
}): JSX.Element {
  const tradeIds = useMemo(() => trades.map((trade) => trade.tradeId), [trades]);
  const newTradeIds = useNewIds(tradeIds);
  return (
    <section className="lit-panel lit-trades-panel" aria-label="Trades">
      {splitter}
      <header className="lit-panel-header lit-book-header">
        {heading ?? <h3>Trades</h3>}
        <span className="lit-live-dot" data-status={tradesStatus} title={`Trades: ${tradesStatus}`} aria-label={`Trades ${tradesStatus}`} />
      </header>
      <div className="lit-book-columns lit-trades-columns" aria-hidden="true">
        <span>Price</span>
        <span>Size {baseSymbol}</span>
        <span>Time</span>
      </div>
      <div className="lit-trades-list">
        {trades.length === 0 ? (
          <p className="lit-book-empty">No recent trades returned.</p>
        ) : trades.slice(0, TRADES_LIMIT).map((trade) => (
          <button
            type="button"
            key={trade.tradeId}
            className="lit-book-row lit-trade-row"
            data-side={trade.takerSide}
            data-new={newTradeIds.has(trade.tradeId) ? "" : undefined}
            onClick={(event) => onPriceSelect(trade.price, pickKind(event))}
            aria-label={`${trade.takerSide === "buy" ? "Buy" : "Sell"} ${trade.price}, size ${trade.size}`}
          >
            <b>{formatDecimalString(trade.price)}</b>
            <span>{formatDecimalString(trade.size)}</span>
            <span>{tradeTime(trade.timestamp)}</span>
          </button>
        ))}
      </div>
    </section>
  );
}
