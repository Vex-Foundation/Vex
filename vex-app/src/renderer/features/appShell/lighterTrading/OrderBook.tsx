import { useMemo, type JSX } from "react";
import type { LighterTradingCandleConnectionStatus } from "@shared/schemas/lighter-trading.js";
import { formatDecimalString, formatNumber, formatRetrievedAt } from "./format.js";

type BookRow = {
  readonly price: string;
  readonly size: string;
  readonly orderId?: string;
};
export type LighterOrderBookData = {
  readonly asks: readonly BookRow[];
  readonly bids: readonly BookRow[];
};

interface BookLevel {
  readonly price: string;
  readonly size: string;
  readonly total: string;
}

/* Render every level the snapshot provides (the service caps depth at 24 per
 * side). More levels than fit keeps the rail packed solid with no gaps: the
 * inside market stays pinned to the spread while far levels clip at the edges. */
const DEPTH_LIMIT = 24;

function compareUnsignedDecimals(left: string, right: string): number {
  const [leftInteger = "0", leftFraction = ""] = left.split(".");
  const [rightInteger = "0", rightFraction = ""] = right.split(".");
  const normalizedLeftInteger = leftInteger.replace(/^0+(?=\d)/, "");
  const normalizedRightInteger = rightInteger.replace(/^0+(?=\d)/, "");
  if (normalizedLeftInteger.length !== normalizedRightInteger.length) {
    return normalizedLeftInteger.length > normalizedRightInteger.length ? 1 : -1;
  }
  if (normalizedLeftInteger !== normalizedRightInteger) {
    return normalizedLeftInteger > normalizedRightInteger ? 1 : -1;
  }
  const width = Math.max(leftFraction.length, rightFraction.length);
  const normalizedLeftFraction = leftFraction.padEnd(width, "0");
  const normalizedRightFraction = rightFraction.padEnd(width, "0");
  if (normalizedLeftFraction === normalizedRightFraction) return 0;
  return normalizedLeftFraction > normalizedRightFraction ? 1 : -1;
}

function addUnsignedDecimals(left: string, right: string): string {
  const [leftInteger = "0", leftFraction = ""] = left.split(".");
  const [rightInteger = "0", rightFraction = ""] = right.split(".");
  const scale = Math.max(leftFraction.length, rightFraction.length);
  const leftDigits = `${leftInteger}${leftFraction.padEnd(scale, "0")}`;
  const rightDigits = `${rightInteger}${rightFraction.padEnd(scale, "0")}`;
  const sum = (BigInt(leftDigits) + BigInt(rightDigits)).toString().padStart(scale + 1, "0");
  if (scale === 0) return sum;
  const integer = sum.slice(0, -scale) || "0";
  const fraction = sum.slice(-scale).replace(/0+$/, "");
  return fraction.length === 0 ? integer : `${integer}.${fraction}`;
}

function subtractUnsignedDecimals(left: string, right: string): string | null {
  if (compareUnsignedDecimals(left, right) < 0) return null;
  const [leftInteger = "0", leftFraction = ""] = left.split(".");
  const [rightInteger = "0", rightFraction = ""] = right.split(".");
  const scale = Math.max(leftFraction.length, rightFraction.length);
  const leftDigits = BigInt(`${leftInteger}${leftFraction.padEnd(scale, "0")}`);
  const rightDigits = BigInt(`${rightInteger}${rightFraction.padEnd(scale, "0")}`);
  const difference = (leftDigits - rightDigits).toString().padStart(scale + 1, "0");
  if (scale === 0) return difference;
  const integer = difference.slice(0, -scale) || "0";
  const fraction = difference.slice(-scale).replace(/0+$/, "");
  return fraction.length === 0 ? integer : `${integer}.${fraction}`;
}

function sortedRows(rows: readonly BookRow[], side: "ask" | "bid"): BookRow[] {
  const byPrice = new Map<string, string>();
  for (const row of rows) {
    if (!/^\d+(?:\.\d+)?$/.test(row.price) || !/^\d+(?:\.\d+)?$/.test(row.size)) continue;
    byPrice.set(row.price, addUnsignedDecimals(byPrice.get(row.price) ?? "0", row.size));
  }
  return [...byPrice.entries()]
    .map(([price, size]) => ({ price, size }))
    .sort((left, right) => side === "ask"
      ? compareUnsignedDecimals(left.price, right.price)
      : compareUnsignedDecimals(right.price, left.price))
    .slice(0, DEPTH_LIMIT);
}

export function bestBookPrice(
  rows: readonly BookRow[],
  side: "ask" | "bid",
): string | null {
  return sortedRows(rows, side)[0]?.price ?? null;
}

function cumulativeLevels(rows: readonly BookRow[], side: "ask" | "bid"): BookLevel[] {
  let cumulative = "0";
  return sortedRows(rows, side).map((row) => {
    cumulative = addUnsignedDecimals(cumulative, row.size);
    return { price: row.price, size: row.size, total: cumulative };
  });
}

function BookSide({ rows, side }: {
  readonly rows: readonly BookRow[];
  readonly side: "ask" | "bid";
}): JSX.Element {
  const { levels, maxTotal } = useMemo(() => {
    const best = cumulativeLevels(rows, side);
    // Asks read far → best (best pinned to the spread at the bottom); bids best → far.
    return {
      levels: side === "ask" ? [...best].reverse() : best,
      maxTotal: Number(best.at(-1)?.total ?? 0),
    };
  }, [rows, side]);

  if (levels.length === 0) {
    return <p className="lit-book-empty">No {side === "ask" ? "asks" : "bids"}</p>;
  }

  return (
    <div className="lit-book-side" data-side={side}>
      {levels.map((level) => {
        const percent = maxTotal > 0 ? Math.min(100, (Number(level.total) / maxTotal) * 100) : 0;
        return (
          <div className="lit-book-row" key={`${side}:${level.price}`}>
            <span className="lit-book-depth" style={{ width: `${percent}%` }} aria-hidden="true" />
            <span className="lit-book-price">{formatDecimalString(level.price)}</span>
            <span className="lit-book-size">{formatDecimalString(level.size)}</span>
            <span className="lit-book-total">{formatDecimalString(level.total)}</span>
          </div>
        );
      })}
    </div>
  );
}

export function OrderBook({ book, symbol, status, receivedAt }: {
  readonly book: LighterOrderBookData;
  readonly symbol?: string;
  readonly status?: LighterTradingCandleConnectionStatus;
  readonly receivedAt?: number | null;
}): JSX.Element {
  const bestAsk = bestBookPrice(book.asks, "ask");
  const bestBid = bestBookPrice(book.bids, "bid");
  const ask = bestAsk === null ? null : Number(bestAsk);
  const bid = bestBid === null ? null : Number(bestBid);
  const spread = bestAsk === null || bestBid === null
    ? null
    : subtractUnsignedDecimals(bestAsk, bestBid);
  const mid = ask !== null && bid !== null ? (ask + bid) / 2 : null;
  const spreadPercent = spread !== null && mid !== null && mid > 0
    ? (Number(spread) / mid) * 100
    : null;

  return (
    <section className="lit-panel lit-order-book" aria-labelledby="lit-order-book-title">
      <header className="lit-panel-header">
        <h3 id="lit-order-book-title">Order book</h3>
        <span>
          {receivedAt === null || receivedAt === undefined
            ? "REST snapshot"
            : status === "live" ? "Live depth" : "Depth delayed"}
          {receivedAt === null || receivedAt === undefined ? "" : ` · ${formatRetrievedAt(receivedAt)}`}
        </span>
      </header>
      <div className="lit-book-columns" aria-hidden="true">
        <span>Price</span>
        <span>Size{symbol === undefined ? "" : ` ${symbol}`}</span>
        <span>Total</span>
      </div>
      <div className="lit-book-scroll">
        <BookSide rows={book.asks} side="ask" />
        <div className="lit-book-spread">
          <strong>{formatDecimalString(spread)}</strong>
          <span>Spread</span>
          <strong>{spreadPercent === null ? "—" : `${formatNumber(spreadPercent)}%`}</strong>
        </div>
        <BookSide rows={book.bids} side="bid" />
      </div>
    </section>
  );
}
