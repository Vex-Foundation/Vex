/**
 * THE LIGHTER PLATES' SAMPLE CONTENT - the figures and words the desk plates
 * draw. A plate's, never the product's: nothing here is read from Lighter,
 * an account or a wallet, and none of it is a real price, position or order.
 * The numbers are plausible and invented, rounded to the market's own
 * precision (BTC perp: price to 0.1, size to 0.0001), so the plate reads like
 * a desk without pretending to be one.
 *
 * The candles are a seeded walk (an LCG, not `Math.random`), so every capture
 * of a plate draws the same chart.
 */

export const PLATE_MARKET = {
  ticker: "BTC",
  product: "Perp",
  deployment: "Lighter Core",
  last: "64,100.0",
  change: "+1.42%",
  mark: "64,100.0",
  index: "64,098.2",
  volume: "$1.82B",
  openInterest: "$159.47M",
  funding: "0.0012%",
  countdown: "35:36",
} as const;

export interface PlateCandle {
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
}

/** A seeded walk of `count` five-minute candles that ends on the plate's last price. */
export function plateCandles(count: number): readonly PlateCandle[] {
  let seed = 20261104;
  const next = (): number => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
  const raw: PlateCandle[] = [];
  let price = 63_740;
  for (let i = 0; i < count; i += 1) {
    const drift = Math.sin(i / 9) * 7 + (i > count * 0.6 ? 4 : 1.5);
    const open = price;
    const close = open + (next() - 0.47) * 46 + drift;
    const high = Math.max(open, close) + next() * 18;
    const low = Math.min(open, close) - next() * 18;
    raw.push({ open, high, low, close, volume: 0.4 + next() * 2.6 + (Math.abs(close - open) > 30 ? 1.4 : 0) });
    price = close;
  }
  // Shift the walk so the last close lands on the market bar's last price.
  const last = raw[raw.length - 1];
  const shift = last === undefined ? 0 : 64_100 - last.close;
  return raw.map((candle) => ({
    open: candle.open + shift,
    high: candle.high + shift,
    low: candle.low + shift,
    close: candle.close + shift,
    volume: candle.volume,
  }));
}

/** One side of the book: price, size (BTC) and the depth bar's share of the widest level. */
export interface PlateLevel {
  readonly price: string;
  readonly size: string;
  readonly depth: number;
}

export const PLATE_BIDS: readonly PlateLevel[] = [
  { price: "64,100.0", size: "0.41230", depth: 0.42 },
  { price: "64,099.9", size: "0.09800", depth: 0.18 },
  { price: "64,099.8", size: "0.27500", depth: 0.34 },
  { price: "64,099.7", size: "0.60010", depth: 0.71 },
  { price: "64,099.6", size: "0.13300", depth: 0.24 },
  { price: "64,099.5", size: "0.05420", depth: 0.12 },
  { price: "64,099.4", size: "0.88100", depth: 0.96 },
];

export const PLATE_ASKS: readonly PlateLevel[] = [
  { price: "64,100.1", size: "0.22950", depth: 0.3 },
  { price: "64,100.2", size: "0.04170", depth: 0.1 },
  { price: "64,100.3", size: "0.50000", depth: 0.62 },
  { price: "64,100.4", size: "0.12044", depth: 0.2 },
  { price: "64,100.5", size: "0.31500", depth: 0.4 },
  { price: "64,100.6", size: "0.08210", depth: 0.14 },
  { price: "64,100.7", size: "0.70400", depth: 0.82 },
];

/** The account dock's summary strip. */
export const PLATE_ACCOUNT = {
  equity: "4,862.40",
  available: "3,136.18",
  unrealized: "+32.94",
  unrealizedShare: "+0.68%",
  margin: "1,726.22",
  marginShare: 35,
  settlement: "USDC",
} as const;

/** The dock's two open positions: a BTC long in profit, an ETH short at a small loss. */
export interface PlatePosition {
  readonly market: string;
  readonly side: "Long" | "Short";
  readonly leverage: string;
  readonly size: string;
  readonly entry: string;
  readonly mark: string;
  readonly liquidation: string;
  readonly margin: string;
  readonly pnl: string;
  readonly roe: string;
  readonly gain: boolean;
  readonly protection: string;
}

export const PLATE_POSITIONS: readonly PlatePosition[] = [
  {
    market: "BTC",
    side: "Long",
    leverage: "10x Cross",
    size: "0.2000 BTC",
    entry: "63,920.0",
    mark: "64,100.0",
    liquidation: "51,940.0",
    margin: "1,282.00",
    pnl: "+36.00",
    roe: "+2.82%",
    gain: true,
    protection: "SL 62,800.0",
  },
  {
    market: "ETH",
    side: "Short",
    leverage: "5x Cross",
    size: "0.6500 ETH",
    entry: "3,412.40",
    mark: "3,417.11",
    liquidation: "4,880.20",
    margin: "444.22",
    pnl: "-3.06",
    roe: "-0.69%",
    gain: false,
    protection: "None",
  },
];
