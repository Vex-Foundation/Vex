/**
 * OHLCV bucketing for BONDING-CURVE trades, shared by both curve sources.
 *
 * WHY THIS EXISTS AT ALL. GeckoTerminal indexes a Virtuals agent only once it
 * has graduated to an AMM pool (and on Solana, where the curve itself is a
 * Meteora DBC pool it happens to index). On Base and on Robinhood a bonding
 * agent's curve is an `FPairV2` contract that no OHLCV provider carries, and
 * `virtuals__agent_candles_list` answered those agents with a 404 - which is
 * precisely the pre-graduation population a trader cares about. The two curve
 * sources (`curve-tape.ts` over the provider's trade feed, `curve-chain.ts`
 * over the pair's own `Swap` logs) therefore have to BUILD the candles, and
 * both build them the same way. That shared arithmetic is this module.
 *
 * NO FLOATS ANYWHERE ON THIS PATH (rule 90). A candle is a price and two token
 * volumes, so every value is carried as a scaled `bigint` and rendered to a
 * decimal string exactly once, at the edge. Nothing here parses a token amount
 * into a JS number, and comparing two prices to find a bucket's high and low is
 * a `bigint` comparison, never a `Number()` round trip - the tape's own prices
 * already arrive rounded at the sixteenth significant digit because the
 * PROVIDER put them through a float, and this module refuses to add a second
 * such loss on top of it.
 *
 * THE ONE PLACE PRECISION IS BOUNDED, AND IT IS REPORTED RATHER THAN HIDDEN.
 * A price is a QUOTIENT of two token amounts and is generally not a finite
 * decimal, so `PRICE_DECIMALS` fixes the rendering at 36 places and the
 * division truncates there. That is a rendering precision on a derived ratio,
 * the same class as the parsing exceptions rule 09 allows, not a cut of
 * content a reader needed: 36 places is eighteen orders of magnitude finer
 * than the 18-decimal amounts the quotient came from.
 */

/** Decimal places every rendered PRICE carries. See the header. */
export const PRICE_DECIMALS = 36;

/**
 * Decimal places every rendered AMOUNT carries.
 *
 * Both sides of a Virtuals curve are 18-decimal ERC-20s (the agent token and
 * VIRTUAL), so at 18 an on-chain amount round-trips EXACTLY: the scaled bigint
 * is literally the integer the log carried.
 */
export const AMOUNT_DECIMALS = 18;

/** Seconds in one bucket of each timeframe, before `aggregate` multiplies it. */
export const CURVE_TIMEFRAME_SECONDS = {
  minute: 60,
  hour: 3_600,
  day: 86_400,
} as const satisfies Record<string, number>;

export type CurveTimeframe = keyof typeof CURVE_TIMEFRAME_SECONDS;

/**
 * One curve trade, normalized by whichever source produced it.
 *
 * Amounts are WHOLE TOKENS scaled by `AMOUNT_DECIMALS` and the price is VIRTUAL
 * per agent token scaled by `PRICE_DECIMALS`. A source hands these over already
 * scaled precisely so that the exact on-chain integers never pass through a
 * string on their way here.
 */
export interface NormalizedCurveTrade {
  /** Unix SECONDS. */
  readonly timestampSeconds: number;
  /** VIRTUAL per agent token, scaled by `PRICE_DECIMALS`. */
  readonly priceScaled: bigint;
  /** Agent-token amount, scaled by `AMOUNT_DECIMALS`. */
  readonly baseAmountScaled: bigint;
  /** VIRTUAL amount, scaled by `AMOUNT_DECIMALS`. */
  readonly quoteAmountScaled: bigint;
  readonly isBuy: boolean;
}

/**
 * One completed bucket. Every number is a decimal string for the same reason
 * the inputs were bigints: these are token amounts on a market-data path.
 */
export interface CurveCandle {
  /** Bucket START, unix seconds, aligned to a whole multiple of the span. */
  timestampSeconds: number;
  /** VIRTUAL per agent token. */
  open: string;
  high: string;
  low: string;
  close: string;
  /** VIRTUAL that changed hands in the bucket. */
  volumeVirtual: string;
  /** Agent tokens that changed hands in the bucket. */
  volumeToken: string;
  /** Trades in the bucket. A bucket with no trades is ABSENT, never zero-filled. */
  tradeCount: number;
  buyCount: number;
  sellCount: number;
}

/**
 * Render a scaled bigint as a plain decimal string.
 *
 * Trailing fractional zeros are trimmed because they are noise, not precision;
 * the integer part is never touched. Exponent notation is never emitted - a
 * price of 1e-20 renders as `0.00000000000000000001`, which is what a reader
 * (and a downstream exact parser) can use without a second decoding rule.
 */
export function formatScaled(value: bigint, decimals: number): string {
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = digits.slice(digits.length - decimals).replace(/0+$/, "");
  const sign = negative ? "-" : "";
  return fraction.length === 0 ? `${sign}${whole}` : `${sign}${whole}.${fraction}`;
}

/**
 * Parse a plain decimal string into a scaled bigint, EXACTLY.
 *
 * Returns null for anything that is not a plain decimal, including exponent
 * notation: a source that starts sending `1e-20` must be seen to change rather
 * than be quietly reinterpreted here. Extra fractional digits beyond `decimals`
 * are truncated, which only happens when a source sends more precision than the
 * scale carries.
 */
export function parseDecimalToScaled(raw: string, decimals: number): bigint | null {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(raw.trim());
  if (match === null) return null;
  const [, sign, whole, fraction = ""] = match;
  const padded = (fraction + "0".repeat(decimals)).slice(0, decimals);
  const value = BigInt(whole!) * 10n ** BigInt(decimals) + BigInt(padded === "" ? "0" : padded);
  return sign === "-" ? -value : value;
}

/**
 * The exact price of one trade, as VIRTUAL per agent token.
 *
 * Both raw amounts are integers in their own token's smallest unit and both
 * tokens carry 18 decimals, so the decimal points cancel and the quotient is
 * already in whole-token terms. Returns null for a zero base amount rather than
 * dividing by it: a `Swap` that moved no agent token has no price, and a
 * fabricated one would sit in a chart looking exactly like a real quote.
 */
export function priceFromRawAmounts(
  quoteRaw: bigint,
  baseRaw: bigint,
): bigint | null {
  if (baseRaw <= 0n || quoteRaw < 0n) return null;
  return (quoteRaw * 10n ** BigInt(PRICE_DECIMALS)) / baseRaw;
}

/** The span of one candle in seconds. */
export function bucketSpanSeconds(timeframe: CurveTimeframe, aggregate: number): number {
  return CURVE_TIMEFRAME_SECONDS[timeframe] * aggregate;
}

/**
 * The bucket a timestamp belongs to, as the bucket's START.
 *
 * Aligned to the unix epoch, which is the same alignment GeckoTerminal uses, so
 * a caller that pages from one source into the other lands on the same grid
 * instead of on a series shifted by part of a bucket.
 */
export function bucketStartSeconds(timestampSeconds: number, spanSeconds: number): number {
  return Math.floor(timestampSeconds / spanSeconds) * spanSeconds;
}

/**
 * Fold trades into candles, OLDEST BUCKET FIRST.
 *
 * The trades may arrive in any order and may repeat: a source that pages over a
 * block range can legitimately see the same log twice at a window seam, so the
 * caller de-duplicates by trade identity BEFORE calling this. This function
 * owns the arithmetic only.
 *
 * Buckets with no trades are OMITTED, never emitted with zero volume. A curve
 * that did not trade for six hours has no price during those hours, and a
 * zero-filled bar would assert one - and would also drag a high or a low to
 * zero for any reader that scanned the column.
 */
export function bucketTradesIntoCandles(
  trades: readonly NormalizedCurveTrade[],
  spanSeconds: number,
): CurveCandle[] {
  interface Accumulator {
    start: number;
    openTs: number;
    closeTs: number;
    open: bigint;
    close: bigint;
    high: bigint;
    low: bigint;
    volumeQuote: bigint;
    volumeBase: bigint;
    tradeCount: number;
    buyCount: number;
    sellCount: number;
  }

  const byBucket = new Map<number, Accumulator>();
  for (const trade of trades) {
    const start = bucketStartSeconds(trade.timestampSeconds, spanSeconds);
    const existing = byBucket.get(start);
    if (existing === undefined) {
      byBucket.set(start, {
        start,
        openTs: trade.timestampSeconds,
        closeTs: trade.timestampSeconds,
        open: trade.priceScaled,
        close: trade.priceScaled,
        high: trade.priceScaled,
        low: trade.priceScaled,
        volumeQuote: trade.quoteAmountScaled,
        volumeBase: trade.baseAmountScaled,
        tradeCount: 1,
        buyCount: trade.isBuy ? 1 : 0,
        sellCount: trade.isBuy ? 0 : 1,
      });
      continue;
    }
    // Open and close follow TIME, not arrival order, because a source is free
    // to hand these over newest-first (the tape does exactly that).
    if (trade.timestampSeconds < existing.openTs) {
      existing.openTs = trade.timestampSeconds;
      existing.open = trade.priceScaled;
    }
    if (trade.timestampSeconds >= existing.closeTs) {
      existing.closeTs = trade.timestampSeconds;
      existing.close = trade.priceScaled;
    }
    if (trade.priceScaled > existing.high) existing.high = trade.priceScaled;
    if (trade.priceScaled < existing.low) existing.low = trade.priceScaled;
    existing.volumeQuote += trade.quoteAmountScaled;
    existing.volumeBase += trade.baseAmountScaled;
    existing.tradeCount += 1;
    if (trade.isBuy) existing.buyCount += 1;
    else existing.sellCount += 1;
  }

  return [...byBucket.values()]
    .sort((a, b) => a.start - b.start)
    .map((bucket) => ({
      timestampSeconds: bucket.start,
      open: formatScaled(bucket.open, PRICE_DECIMALS),
      high: formatScaled(bucket.high, PRICE_DECIMALS),
      low: formatScaled(bucket.low, PRICE_DECIMALS),
      close: formatScaled(bucket.close, PRICE_DECIMALS),
      volumeVirtual: formatScaled(bucket.volumeQuote, AMOUNT_DECIMALS),
      volumeToken: formatScaled(bucket.volumeBase, AMOUNT_DECIMALS),
      tradeCount: bucket.tradeCount,
      buyCount: bucket.buyCount,
      sellCount: bucket.sellCount,
    }));
}
