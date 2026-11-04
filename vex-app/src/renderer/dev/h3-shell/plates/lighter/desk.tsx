/**
 * The desk under the header, in H3 cells (the plate's proposal for rows
 * S8-08 to S8-10): the market bar, the chart over the book at the left, the
 * ticket at the right, and the account dock across the foot. Static markup on
 * the shell's tokens (`lighter-plates.css`); the market marks are the desk's
 * own `MarketSymbol`. What each part holds is today's desk
 * (`lighterTrading/*`), re-laid in cells: nothing is added that the desk has
 * no data for, and nothing here is live.
 */

import type { JSX, ReactNode } from "react";
import {
  LineCamera,
  LineChevronDown,
  LineChevronRight,
  LineClose,
  LineCursor,
  LineFib,
  LineHLine,
  LineRectangle,
  LineRefresh,
  LineRuler,
  LineShield,
  LineTrendLine,
} from "../../../../components/icons/line/index.js";
import { VexMark } from "../../../../components/common/VexMark.js";
import { MarketSymbol } from "../../../../features/appShell/lighterTrading/MarketSymbol.js";
import { PlateChart } from "./chart.js";
import {
  PLATE_ACCOUNT,
  PLATE_ASKS,
  PLATE_BIDS,
  PLATE_MARKET,
  PLATE_POSITIONS,
  type PlatePosition,
} from "./sample.js";

const BTC = { marketId: 1, baseAssetId: 0, symbol: "BTC", marketType: "perp" } as const;
const ETH = { marketId: 0, baseAssetId: 0, symbol: "ETH", marketType: "perp" } as const;

/** A row of cells where one is chosen (on raised 2). Static: nothing switches. */
function Seg({ items, chosen, className }: {
  readonly items: readonly ReactNode[];
  readonly chosen: number;
  readonly className?: string;
}): JSX.Element {
  return (
    <div className={className === undefined ? "lp-seg" : `lp-seg ${className}`}>
      {items.map((item, i) => (
        <button type="button" key={i} aria-pressed={i === chosen}>
          {item}
        </button>
      ))}
    </div>
  );
}

function Figure({ label, value, shed }: {
  readonly label: string;
  readonly value: string;
  readonly shed?: string;
}): JSX.Element {
  return (
    <div className="lp-bar__cell" data-lp-shed={shed}>
      <span className="lp-cap">{label}</span>
      <span className="lp-num">{value}</span>
    </div>
  );
}

/** The market bar: the market key, the deployment, the price and the figures, Live. */
export function MarketBarCells(): JSX.Element {
  return (
    <div className="lp-bar" aria-label="Selected market summary">
      <button type="button" className="lp-bar__cell lp-bar__market" aria-label="Choose a market">
        <MarketSymbol environment="core" market={BTC} />
        <span className="lp-bar__ticker">{PLATE_MARKET.ticker}</span>
        <span className="lp-cap lp-bar__product">{PLATE_MARKET.product}</span>
        <LineChevronDown size={14} />
      </button>
      <div className="lp-bar__cell lp-bar__deploy">
        <Seg items={["Core", "RHC"]} chosen={0} />
      </div>
      <div className="lp-bar__cell lp-bar__last">
        <span className="lp-num">{PLATE_MARKET.last}</span>
        <span className="lp-num lp-gain">{PLATE_MARKET.change}</span>
      </div>
      <Figure label="Mark" value={PLATE_MARKET.mark} shed="mark" />
      <Figure label="Index" value={PLATE_MARKET.index} shed="index" />
      <Figure label="24h volume" value={PLATE_MARKET.volume} shed="volume" />
      <Figure label="Open interest" value={PLATE_MARKET.openInterest} shed="oi" />
      <Figure label="Funding / countdown" value={`${PLATE_MARKET.funding} / ${PLATE_MARKET.countdown}`} />
      <div className="lp-bar__cell lp-bar__live">
        <span className="lp-square lp-square--green" aria-hidden />
        <span className="lp-cap">Live</span>
      </div>
    </div>
  );
}

/** The chart cell: its interval and study keys, the drawing tools, the canvas. */
export function ChartCell({ entry }: { readonly entry: number | null }): JSX.Element {
  return (
    <section className="lp-chart" aria-label="Price chart">
      <div className="lp-chart__bar">
        <Seg items={["1m", "5m", "15m", "1h", "4h", "1d"]} chosen={1} />
        <button type="button" className="lp-chart__menu">
          Candles <LineChevronDown size={14} />
        </button>
        <button type="button" className="lp-chart__menu" data-lp-shed="">
          Indicators
        </button>
        <button
          type="button"
          className="lp-chart__menu lp-chart__menu--end"
          aria-label="Save a picture of the chart"
          data-lp-shed=""
        >
          <LineCamera size={16} />
        </button>
      </div>
      <div className="lp-chart__tools" aria-label="Drawing tools">
        <span data-on="">
          <LineCursor size={16} />
        </span>
        <span>
          <LineTrendLine size={16} />
        </span>
        <span>
          <LineHLine size={16} />
        </span>
        <span>
          <LineRectangle size={16} />
        </span>
        <span>
          <LineFib size={16} />
        </span>
        <span>
          <LineRuler size={16} />
        </span>
      </div>
      <PlateChart entry={entry} />
    </section>
  );
}

/** The book, side by side: bids in gain type, asks in loss type, their depth from the centre out. */
export function BookCell({ rows }: { readonly rows: number }): JSX.Element {
  const bids = PLATE_BIDS.slice(0, rows);
  const asks = PLATE_ASKS.slice(0, rows);
  return (
    <section className="lp-book" aria-label="Order book">
      <div className="lp-book__head">
        <Seg items={["Order book", "Trades"]} chosen={0} />
        <Seg items={[<span key="t" className="lp-num">0.1</span>]} chosen={-1} />
        <Seg items={["BTC", "USD"]} chosen={0} className="lp-seg--end lp-shed-band" />
      </div>
      <div className="lp-book__spread">
        <span className="lp-num lp-gain">{PLATE_MARKET.last} ↑</span>
        <span className="lp-muted">
          Spread <span className="lp-num lp-ink-2">0.1</span> <span className="lp-num">(0.02 bp)</span>
        </span>
        <span className="lp-muted" data-lp-shed="">
          Mark <span className="lp-num lp-ink-2">{PLATE_MARKET.mark}</span>
        </span>
      </div>
      <div className="lp-book__table">
        <span className="lp-book__th" data-col="bid-size">Size (BTC)</span>
        <span className="lp-book__th" data-col="bid">Bid</span>
        <span className="lp-book__th" data-col="ask">Ask</span>
        <span className="lp-book__th" data-col="ask-size">Size (BTC)</span>
        {bids.map((bid, i) => {
          const ask = asks[i];
          return [
            <span key={`bs${String(i)}`} data-col="bid-size">
              <span className="lp-num lp-ink-2">{bid.size}</span>
            </span>,
            <span key={`bp${String(i)}`} data-col="bid">
              <i className="lp-book__bar lp-book__bar--bid" style={{ width: `${String(Math.round(bid.depth * 200))}%` }} />
              <span className="lp-num lp-gain">{bid.price}</span>
            </span>,
            <span key={`ap${String(i)}`} data-col="ask">
              <i
                className="lp-book__bar lp-book__bar--ask"
                style={{ width: `${String(Math.round((ask?.depth ?? 0) * 200))}%` }}
              />
              <span className="lp-num lp-loss">{ask?.price}</span>
            </span>,
            <span key={`as${String(i)}`} data-col="ask-size">
              <span className="lp-num lp-ink-2">{ask?.size}</span>
            </span>,
          ];
        })}
      </div>
      <div className="lp-book__ratio">
        <span className="lp-num lp-gain">B 54%</span>
        <i aria-hidden>
          <b style={{ width: "54%" }} />
          <s />
        </i>
        <span className="lp-num lp-loss">46% S</span>
      </div>
    </section>
  );
}

/** The ticket: account context, the order's form, the facts, then the keys at the foot. */
export function TicketCell(): JSX.Element {
  return (
    <section className="lp-ticket" aria-label="Order ticket">
      <div className="lp-ticket__row">
        <button type="button" className="lp-ticket__chip lp-key">
          Cross · <span className="lp-num">10x</span> <LineChevronRight size={14} />
        </button>
        <span className="lp-ticket__spacer" />
        <span className="lp-cap lp-cap--small lp-muted" data-lp-shed="">
          Available
        </span>
        <span className="lp-num">
          {PLATE_ACCOUNT.available} <span className="lp-muted">{PLATE_ACCOUNT.settlement}</span>
        </span>
      </div>
      <div className="lp-ticket__row lp-ticket__row--cells">
        <Seg items={["Market", "Limit"]} chosen={0} />
      </div>
      {/* Only the order's fields scroll when the desk is short; the account
        * context above and the keys below stay put (as today's ticket). */}
      <div className="lp-ticket__body">
        <p className="lp-ticket__hint">Price click → Limit · Shift-click → Trigger</p>
        <div className="lp-ticket__block">
          <div className="lp-ticket__label">
            <span className="lp-cap">Size</span>
            <Seg items={["Qty", "Risk"]} chosen={0} />
          </div>
          <div className="lp-ticket__field lp-num">
            0.0200 <span className="lp-muted">BTC</span>
          </div>
          <div className="lp-ticket__presets lp-num">
            <span>25%</span>
            <span>50%</span>
            <span>75%</span>
            <span>100%</span>
          </div>
        </div>
        <div className="lp-ticket__row">
          <span className="lp-cap lp-muted">Slippage</span>
          <span className="lp-ticket__spacer" />
          <div className="lp-ticket__presets lp-ticket__presets--inline lp-num">
            <span>0.1%</span>
            <span data-on="">0.5%</span>
            <span>1%</span>
          </div>
        </div>
        <div className="lp-ticket__row">
          <span className="lp-tick lp-cap">
            <i aria-hidden /> Reduce-only
          </span>
          <span className="lp-tick lp-cap">
            <i aria-hidden /> TP/SL
          </span>
        </div>
        <dl className="lp-ticket__facts lp-num">
          <dt>Order value</dt>
          <dd>1,282.00 USDC</dd>
          <dt>Cost</dt>
          <dd>128.20 USDC</dd>
          <dt>Max size</dt>
          <dd>0.4893 BTC</dd>
          <dt>Liq. price</dt>
          <dd>51,610.0</dd>
          <dt>Fees</dt>
          <dd>Vex 0.02% · about 0.26 USDC</dd>
        </dl>
      </div>
      <div className="lp-ticket__foot">
        <button type="button" className="lp-key lp-ticket__ask">
          <VexMark size={16} /> Review with Vex
        </button>
        <p className="lp-ticket__note">Nothing signs until you confirm.</p>
        <div className="lp-ticket__sides" role="group" aria-label="Order side">
          <button type="button" className="lp-side">
            <b className="lp-gain">Long</b>
            <small>Market · 0.0200 BTC</small>
          </button>
          <button type="button" className="lp-side">
            <b className="lp-loss">Short</b>
            <small>Market · 0.0200 BTC</small>
          </button>
        </div>
      </div>
    </section>
  );
}

function PositionRow({ position, market }: {
  readonly position: PlatePosition;
  readonly market: { readonly marketId: number; readonly baseAssetId: number; readonly symbol: string; readonly marketType: "perp" };
}): JSX.Element {
  const tone = position.gain ? "lp-gain" : "lp-loss";
  return (
    <>
      <span className="lp-dock__market">
        <MarketSymbol environment="core" market={market} />
        <span>
          <span>{position.market}</span>
          <span className="lp-muted">
            <span className={position.side === "Long" ? "lp-gain" : "lp-loss"}>{position.side}</span> · {position.leverage}
          </span>
        </span>
      </span>
      <span className="lp-num">{position.size}</span>
      <span className="lp-num">{position.entry}</span>
      <span className="lp-num">{position.mark}</span>
      <span className="lp-num">{position.liquidation}</span>
      <span className="lp-num" data-lp-shed="">
        {position.margin}
      </span>
      <span className={`lp-num ${tone}`}>
        <span>{position.pnl}</span>
        <span>{position.roe}</span>
      </span>
      <span className="lp-num lp-ink-2" data-lp-shed="">
        {position.protection}
      </span>
      <span className="lp-dock__actions">
        <button type="button" aria-label={`Ask Vex about the ${position.market} position`}>
          <VexMark size={14} />
        </button>
        <button type="button" data-lp-shed-word="" aria-label={`Protect the ${position.market} position`}>
          <LineShield size={14} />
          <span>&nbsp;Protect</span>
        </button>
        <button type="button" aria-label={`Close the ${position.market} position`}>
          <LineClose size={14} />
        </button>
      </span>
    </>
  );
}

/** The account dock: tabs, the account's summary strip, the two positions. */
export function DockCell(): JSX.Element {
  const lit = Math.round(PLATE_ACCOUNT.marginShare / 10);
  return (
    <section className="lp-dock" aria-label="Lighter account">
      <div className="lp-dock__tabs">
        <Seg
          items={[
            <>
              Positions <span className="lp-num">2</span>
            </>,
            <>
              Open orders <span className="lp-num">0</span>
            </>,
            "Trade history",
            "Assets",
          ]}
          chosen={0}
        />
        <button type="button" className="lp-key lp-dock__refresh" aria-label="Refresh the account">
          <LineRefresh size={14} /> Refresh
        </button>
      </div>
      <div className="lp-dock__summary">
        <span>
          <span className="lp-cap">Equity</span>
          <span className="lp-num">
            {PLATE_ACCOUNT.equity} {PLATE_ACCOUNT.settlement}
          </span>
        </span>
        <span data-lp-shed="">
          <span className="lp-cap">Available</span>
          <span className="lp-num">{PLATE_ACCOUNT.available}</span>
        </span>
        <span>
          <span className="lp-cap">Unrealized PnL</span>
          <span className="lp-num lp-gain">
            {PLATE_ACCOUNT.unrealized} ({PLATE_ACCOUNT.unrealizedShare})
          </span>
        </span>
        <span>
          <span className="lp-cap">Margin</span>
          <span className="lp-num">{PLATE_ACCOUNT.margin}</span>
          <span className="lp-meter" aria-hidden data-lp-shed="">
            {Array.from({ length: 10 }, (_, i) => (
              <i key={i} data-on={i < lit ? "" : undefined} />
            ))}
          </span>
          <span className="lp-num lp-muted">{PLATE_ACCOUNT.marginShare}%</span>
        </span>
      </div>
      <div className="lp-dock__table">
        <span className="lp-dock__th">Market</span>
        <span className="lp-dock__th">Size</span>
        <span className="lp-dock__th">Entry</span>
        <span className="lp-dock__th">Mark</span>
        <span className="lp-dock__th">Liq. price</span>
        <span className="lp-dock__th" data-lp-shed="">
          Margin
        </span>
        <span className="lp-dock__th">uPnL (ROE)</span>
        <span className="lp-dock__th" data-lp-shed="">
          TP / SL
        </span>
        <span className="lp-dock__th">Actions</span>
        {PLATE_POSITIONS.map((position) => (
          <PositionRow key={position.market} position={position} market={position.market === "BTC" ? BTC : ETH} />
        ))}
      </div>
    </section>
  );
}

/**
 * The whole desk. `ticket` is what stands in the ticket's column: the
 * ticket, or the review that replaces it while a desk order waits.
 */
export function Desk({ ticket, bookRows }: {
  readonly ticket: JSX.Element;
  readonly bookRows: number;
}): JSX.Element {
  return (
    <section className="lp-desk" aria-label="Lighter desk" data-vex-area="lighter-desk-plate">
      <MarketBarCells />
      <div className="lp-upper">
        <div className="lp-main">
          <ChartCell entry={63_920} />
          <BookCell rows={bookRows} />
        </div>
        {ticket}
      </div>
      <DockCell />
    </section>
  );
}
