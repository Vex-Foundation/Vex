/**
 * Bonding-curve candles built from the provider's own TRADE TAPE.
 *
 * The fast path for a bonding agent on the two chains the tape covers (BASE and
 * SOLANA - `trades/vp-api.ts` documents why those two and no others). One HTTP
 * call yields the agent's recent trades and `bucketing.ts` folds them into
 * OHLCV, so a chart for a pre-graduation agent costs a single request.
 *
 * THE TAPE HAS NO CURSOR, AND THAT IS THE WHOLE REASON THIS MODULE REPORTS
 * COVERAGE THE WAY IT DOES. Measured live on 2026-09-05 against CULTOS
 * (agent 135655): `offset`, `page`, `skip`, `before`, `beforeTimestamp`,
 * `endTime` and `toTimestamp` were EACH sent and EACH silently ignored - every
 * one returned the byte-identical newest window. The only depth knob is
 * `limit`, and the provider states its own ceiling in its rejection body:
 *
 *   limit=1001 -> HTTP 400 {"code":-400,"message":"param limit maxLimit 1000"}
 *
 * So this source is a NEWEST-N SNAPSHOT, not a walkable feed. An agent with
 * more than 1000 curve trades has older history that this endpoint cannot
 * reach at ALL, by any parameter. When the tape comes back full, that is not
 * "the beginning of the curve" - it is the ceiling, and
 * {@link TapeCandlesCoverage.stopReason} says `tape_ceiling` so the answer can
 * point at the on-chain source instead of presenting a partial history as a
 * complete one.
 *
 * PRECISION. The tape's amounts arrive already rounded at the sixteenth
 * significant digit (measured: a trade whose exact on-chain VIRTUAL amount is
 * 0.876647285282571920 is served as "0.8766472852825719"), because the provider
 * put them through a float before we ever saw them. This module cannot undo
 * that; it only refuses to compound it, parsing the decimal strings EXACTLY
 * into scaled bigints. `curve-chain.ts` is the exact source when precision is
 * what matters, and the tool's reply says which one it used.
 */

import {
  readVpApiTrades,
  VP_API_PROVIDER_MAX_LIMIT,
  type VirtualsCurveTrade,
} from "../trades/vp-api.js";
import type { VirtualsChain } from "../types.js";
import {
  AMOUNT_DECIMALS,
  PRICE_DECIMALS,
  bucketSpanSeconds,
  bucketTradesIntoCandles,
  parseDecimalToScaled,
  type CurveCandle,
  type CurveTimeframe,
  type NormalizedCurveTrade,
} from "./bucketing.js";

/** Why the walk stopped, so a partial history is never read as a complete one. */
export type TapeStopReason =
  /** The tape was shorter than its ceiling: this IS the agent's whole history. */
  | "tape_exhausted"
  /** The tape came back FULL. Older trades exist and this source cannot reach them. */
  | "tape_ceiling";

export interface TapeCandlesCoverage {
  readonly source: "virtuals_tape";
  readonly stopReason: TapeStopReason;
  /** Rows the provider returned, and the ceiling it enforces on that number. */
  readonly tradesReturned: number;
  readonly tapeCeiling: number;
  /** Trades left after the requested window was applied, i.e. what was bucketed. */
  readonly tradesInWindow: number;
  readonly oldestTradeSeconds: number | null;
  readonly newestTradeSeconds: number | null;
  /** True when history certainly exists that this answer does not carry. */
  readonly truncated: boolean;
  readonly note: string;
}

export interface TapeCandlesFound {
  readonly available: true;
  readonly candles: CurveCandle[];
  readonly coverage: TapeCandlesCoverage;
  readonly vpApiChainId: number;
}

export interface TapeCandlesUnavailable {
  readonly available: false;
  readonly reason: string;
}

export type TapeCandlesResult = TapeCandlesFound | TapeCandlesUnavailable;

export interface BuildTapeCandlesParams {
  readonly chain: VirtualsChain;
  /** The BONDING token: `preToken` while on the curve. */
  readonly tokenAddress: string;
  readonly timeframe: CurveTimeframe;
  readonly aggregate: number;
  /** Candles to return, newest-first selection, oldest-first output. */
  readonly limit: number;
  /** Return only buckets strictly BEFORE this unix-seconds mark. */
  readonly beforeTimestampSeconds?: number;
}

/**
 * Normalize one tape row.
 *
 * Returns null when the row cannot be read as a priced trade rather than
 * substituting a zero: the tape's own reader already defaults an unparseable
 * amount to "0", and a zero-priced bar in a chart is a claim, not a gap.
 */
function normalize(trade: VirtualsCurveTrade): NormalizedCurveTrade | null {
  const priceScaled = parseDecimalToScaled(trade.price, PRICE_DECIMALS);
  const baseAmountScaled = parseDecimalToScaled(trade.agentTokenAmount, AMOUNT_DECIMALS);
  const quoteAmountScaled = parseDecimalToScaled(trade.virtualTokenAmount, AMOUNT_DECIMALS);
  if (priceScaled === null || baseAmountScaled === null || quoteAmountScaled === null) {
    return null;
  }
  if (priceScaled <= 0n) return null;
  return {
    timestampSeconds: trade.timestampSeconds,
    priceScaled,
    baseAmountScaled,
    quoteAmountScaled,
    isBuy: trade.isBuy,
  };
}

/**
 * Build candles for one bonding agent from the tape.
 *
 * @returns `{ available: false, reason }` when the chain has no tape at all -
 * never an empty candle list, which would read as "this agent never traded".
 */
export async function buildTapeCandles(
  params: BuildTapeCandlesParams,
): Promise<TapeCandlesResult> {
  const tape = await readVpApiTrades({
    chain: params.chain,
    tokenAddress: params.tokenAddress,
    // Always ask for the provider's full ceiling. The tape has no cursor, so
    // the ONLY way to reach depth is to ask for everything in one call; asking
    // for less would cap the history for no saving the provider cares about.
    limit: VP_API_PROVIDER_MAX_LIMIT,
  });
  if (!tape.supported) return { available: false, reason: tape.reason };

  const all = tape.trades
    .map(normalize)
    .filter((t): t is NormalizedCurveTrade => t !== null);
  const before = params.beforeTimestampSeconds;
  const windowed =
    before === undefined ? all : all.filter((t) => t.timestampSeconds < before);

  const span = bucketSpanSeconds(params.timeframe, params.aggregate);
  const every = bucketTradesIntoCandles(windowed, span);
  // The NEWEST `limit` buckets. Buckets dropped here are older than the window
  // the caller asked for, and `nextBefore` in the handler walks to them.
  const candles = every.slice(-params.limit);

  const timestamps = windowed.map((t) => t.timestampSeconds);
  const atCeiling = tape.trades.length >= VP_API_PROVIDER_MAX_LIMIT;
  const stopReason: TapeStopReason = atCeiling ? "tape_ceiling" : "tape_exhausted";

  return {
    available: true,
    candles,
    vpApiChainId: tape.chainId,
    coverage: {
      source: "virtuals_tape",
      stopReason,
      tradesReturned: tape.trades.length,
      tapeCeiling: VP_API_PROVIDER_MAX_LIMIT,
      tradesInWindow: windowed.length,
      oldestTradeSeconds: timestamps.length === 0 ? null : Math.min(...timestamps),
      newestTradeSeconds: timestamps.length === 0 ? null : Math.max(...timestamps),
      truncated: atCeiling || every.length > candles.length,
      note: atCeiling
        ? `The provider's trade feed returned its FULL ceiling of ${VP_API_PROVIDER_MAX_LIMIT} `
          + "trades, so this agent has older curve history that this source cannot reach: the feed "
          + "has no cursor of any kind (offset, page, skip and four spellings of a timestamp bound "
          + "were each sent live and each silently ignored), and `limit` is capped at "
          + `${VP_API_PROVIDER_MAX_LIMIT} by the provider itself. This is NOT the start of the `
          + "curve. On base, ask for source `onchain` to read the pair's own Swap logs, which have "
          + "no such ceiling. On solana there is no deeper source, so the oldest bucket here is the "
          + "oldest this tool can offer."
        : `The provider's trade feed returned ${tape.trades.length} trades, fewer than its `
          + `${VP_API_PROVIDER_MAX_LIMIT} ceiling, so this is the agent's ENTIRE curve history and `
          + "nothing older exists to fetch.",
    },
  };
}
