import {
  addUnsignedDecimals,
  compareUnsignedDecimals,
  fromScaledInteger,
  isUnsignedDecimal,
  scaledInteger,
  subtractUnsignedDecimals,
} from "./decimal.js";

export type BookSide = "ask" | "bid";

export type BookRow = {
  readonly price: string;
  readonly size: string;
  readonly orderId?: string;
};

export type LighterOrderBookData = {
  readonly asks: readonly BookRow[];
  readonly bids: readonly BookRow[];
};

export interface BookLevel {
  readonly price: string;
  readonly size: string;
  /** Cumulative size from the inside market out to this level. */
  readonly total: string;
}

/* Render every level the snapshot provides (the service caps depth at 24 per
 * side). More levels than fit keeps the rail packed solid with no gaps: the
 * inside market stays pinned to the spread while far levels clip at the edges. */
export const DEPTH_LIMIT = 24;
export const GROUP_MULTIPLIERS = [1, 10, 100] as const;

/** Dedupe by price, sort best-first, and cap at the depth limit. */
export function sortedRows(rows: readonly BookRow[], side: BookSide): BookRow[] {
  const byPrice = new Map<string, string>();
  for (const row of rows) {
    if (!isUnsignedDecimal(row.price) || !isUnsignedDecimal(row.size)) continue;
    byPrice.set(row.price, addUnsignedDecimals(byPrice.get(row.price) ?? "0", row.size));
  }
  return [...byPrice.entries()]
    .map(([price, size]) => ({ price, size }))
    .sort((left, right) => side === "ask"
      ? compareUnsignedDecimals(left.price, right.price)
      : compareUnsignedDecimals(right.price, left.price))
    .slice(0, DEPTH_LIMIT);
}

export function bestBookPrice(rows: readonly BookRow[], side: BookSide): string | null {
  return sortedRows(rows, side)[0]?.price ?? null;
}

export function cumulativeLevels(rows: readonly BookRow[], side: BookSide): BookLevel[] {
  let cumulative = "0";
  return sortedRows(rows, side).map((row) => {
    cumulative = addUnsignedDecimals(cumulative, row.size);
    return { price: row.price, size: row.size, total: cumulative };
  });
}

/** Group levels onto a coarser tick: asks round up, bids round down, so the inside never lies. */
export function groupedLevels(
  rows: readonly BookRow[],
  side: BookSide,
  priceDecimals: number,
  multiplier: number,
): BookLevel[] {
  const sorted = sortedRows(rows, side);
  if (multiplier === 1) return cumulativeLevels(sorted, side);
  const step = BigInt(multiplier);
  const grouped = new Map<string, string>();
  for (const row of sorted) {
    const scaled = scaledInteger(row.price, priceDecimals);
    if (scaled === null) continue;
    const remainder = scaled % step;
    const bucket = remainder === 0n
      ? scaled
      : side === "ask" ? scaled - remainder + step : scaled - remainder;
    const price = fromScaledInteger(bucket, priceDecimals);
    grouped.set(price, addUnsignedDecimals(grouped.get(price) ?? "0", row.size));
  }
  let cumulative = "0";
  return [...grouped.entries()].map(([price, size]) => {
    cumulative = addUnsignedDecimals(cumulative, size);
    return { price, size, total: cumulative };
  });
}

/** The tick a grouping multiplier renders as, e.g. `0.10` for ×10 on two-decimal prices. */
export function groupTickLabel(multiplier: number, priceDecimals: number): string {
  return fromScaledInteger(BigInt(multiplier), priceDecimals).replace(/^0+(?=\d)/, "");
}

export interface BookInside {
  readonly bestAsk: string | null;
  readonly bestBid: string | null;
  /** Exact spread as the provider decimals, null without both sides. */
  readonly spread: string | null;
  readonly mid: number | null;
  /** Spread over mid, in basis points. */
  readonly spreadBps: number | null;
}

export function bookInside(book: LighterOrderBookData): BookInside {
  const bestAsk = bestBookPrice(book.asks, "ask");
  const bestBid = bestBookPrice(book.bids, "bid");
  const spread = bestAsk !== null && bestBid !== null ? subtractUnsignedDecimals(bestAsk, bestBid) : null;
  const mid = bestAsk !== null && bestBid !== null ? (Number(bestAsk) + Number(bestBid)) / 2 : null;
  const spreadValue = spread === null ? null : Number(spread);
  return {
    bestAsk,
    bestBid,
    spread,
    mid,
    spreadBps: spreadValue !== null && mid !== null && mid > 0 ? (spreadValue / mid) * 10_000 : null,
  };
}
