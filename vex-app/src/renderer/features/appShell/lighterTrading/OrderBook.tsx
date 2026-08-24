import { useMemo, type JSX } from "react";
import type { LighterTradingSnapshot } from "@shared/schemas/lighter-trading.js";
import { formatNumber } from "./format.js";

type BookRow = LighterTradingSnapshot["book"]["asks"][number];

function sortedRows(rows: readonly BookRow[], side: "ask" | "bid"): BookRow[] {
  return [...rows]
    .filter((row) => Number.isFinite(Number(row.price)) && Number.isFinite(Number(row.size)))
    .sort((left, right) => side === "ask"
      ? Number(left.price) - Number(right.price)
      : Number(right.price) - Number(left.price))
    .slice(0, 12);
}

export function bestBookPrice(
  rows: readonly BookRow[],
  side: "ask" | "bid",
): string | null {
  return sortedRows(rows, side)[0]?.price ?? null;
}

function BookSide({ rows, side }: {
  readonly rows: readonly BookRow[];
  readonly side: "ask" | "bid";
}): JSX.Element {
  const shown = useMemo(() => sortedRows(rows, side), [rows, side]);
  const maxSize = Math.max(0, ...shown.map((row) => Number(row.size)));

  if (shown.length === 0) {
    return <p className="lit-book-empty">No {side === "ask" ? "asks" : "bids"}</p>;
  }

  return (
    <div className="lit-book-side" data-side={side}>
      {shown.map((row) => {
        const percent = maxSize > 0 ? Math.min(100, (Number(row.size) / maxSize) * 100) : 0;
        return (
          <div className="lit-book-row" key={row.orderId}>
            <span className="lit-book-depth" style={{ width: `${percent}%` }} aria-hidden="true" />
            <span className="lit-book-price">{formatNumber(Number(row.price))}</span>
            <span className="lit-book-size">{formatNumber(Number(row.size))}</span>
          </div>
        );
      })}
    </div>
  );
}

export function OrderBook({ book }: {
  readonly book: LighterTradingSnapshot["book"];
}): JSX.Element {
  const bestAsk = bestBookPrice(book.asks, "ask");
  const bestBid = bestBookPrice(book.bids, "bid");
  const ask = bestAsk === null ? null : Number(bestAsk);
  const bid = bestBid === null ? null : Number(bestBid);
  const spread = ask !== null && bid !== null && ask >= bid ? ask - bid : null;

  return (
    <section className="lit-panel lit-order-book" aria-labelledby="lit-order-book-title">
      <header className="lit-panel-header">
        <h3 id="lit-order-book-title">Order book</h3>
        <span>Price / Size</span>
      </header>
      <div className="lit-book-scroll">
        <BookSide rows={book.asks} side="ask" />
        <div className="lit-book-spread">
          <span>Spread</span>
          <strong>{formatNumber(spread)}</strong>
        </div>
        <BookSide rows={book.bids} side="bid" />
      </div>
    </section>
  );
}
