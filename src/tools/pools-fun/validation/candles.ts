/**
 * `/discover/{token}/ohlcv` validator.
 *
 * The wire sends candles as arrays of arrays:
 * `[unixSeconds, open, high, low, close, volumeUsd]`. That tuple is lifted into
 * named members HERE, at the boundary, so no positional index ever travels
 * further in. Reading a positional OHLCV row is a misread waiting to happen -
 * open and close differ by one array slot, and nothing in the data would tell
 * anyone they had been swapped.
 *
 * All six members are strict finite numbers: a candle with a null price is not
 * a display gap that can be tolerated, it is a candle that cannot be plotted or
 * compared, and dropping it silently would forge a continuous series out of a
 * broken one.
 *
 * ORDER IS NOT ASSUMED. The provider returned oldest-first on pools.fun tokens
 * and newest-first on another launchpad's token in the same probe, so the
 * ordering is measured from the parsed timestamps by the caller and echoed,
 * never asserted here.
 */

import { z } from "zod";
import type { PoolsCandle, PoolsCandles } from "../types.js";
import { POOLS_CHAIN_SLUG } from "../constants.js";
import { address, displayString, finiteNumber, parseOrThrow } from "./_shared.js";

/** One wire candle: a fixed 6-tuple, lifted into named members. */
const candleSchema: z.ZodType<PoolsCandle> = z
  .tuple([finiteNumber, finiteNumber, finiteNumber, finiteNumber, finiteNumber, finiteNumber])
  .transform(([time, open, high, low, close, volumeUsd]) => ({
    time,
    open,
    high,
    low,
    close,
    volumeUsd,
  }));

/**
 * The pool the candles were measured in. Display-tolerant as a BLOCK: if the
 * provider stops naming the pool we still have candles, and the caller says
 * "pool unknown" rather than inventing one.
 */
const poolSchema = z
  .object({
    address,
    // Pinned to the literal for the same reason the discover row's `chain` is:
    // this API answers for Base when the chain parameter goes missing, and a
    // Base pool's candles presented under a Robinhood token would be a wrong
    // chart rather than a missing one.
    network: z.literal(POOLS_CHAIN_SLUG, {
      error: `expected a ${POOLS_CHAIN_SLUG} pool - pools.fun tools are pinned to Robinhood Chain`,
    }),
  })
  .nullish()
  .transform((v) => v ?? null);

/**
 * The quote asset the candle prices are denominated in. Tolerant, but the
 * caller must surface it: an OHLCV series with an unnamed quote asset is a
 * chart of nothing, and pools.fun tokens quote in WETH, USDG or a stock.
 */
const pairSchema = z
  .object({ baseSymbol: displayString, quoteSymbol: displayString })
  .nullish()
  .transform((v) => v ?? null);

const candlesSchema: z.ZodType<PoolsCandles> = z
  .object({
    ohlcv: z.array(candleSchema),
    pool: poolSchema,
    pair: pairSchema,
  })
  .transform(({ ohlcv, pool, pair }) => ({ candles: ohlcv, pool, pair }));

/** Validate a `/discover/{token}/ohlcv` response. */
export function validateCandles(raw: unknown): PoolsCandles {
  return parseOrThrow(candlesSchema, raw);
}
