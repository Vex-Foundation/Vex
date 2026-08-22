/**
 * `pools.candles` handler - OHLCV for ONE pools.fun token (READ-ONLY).
 *
 * Two things this handler refuses to guess:
 *
 * 1. THE ORDER. The spec drafted from the first probe said "newest-first", but a
 *    second measurement on two pools.fun tokens came back OLDEST-first while the
 *    original capture (a token from a different launchpad on the same API) was
 *    newest-first. An echoed constant would therefore have been wrong half the
 *    time, and an agent reading "candles[0] is the latest" off a wrong constant
 *    reads every trend backwards. The order is DERIVED from the timestamps and
 *    reported; when there is no order to derive (0 or 1 candle) it says so.
 * 2. THE QUOTE ASSET. Candle prices are denominated in whatever the pool quotes
 *    in - WETH, USDG or a tokenised stock - so `pair` is surfaced and the prose
 *    names it as the unit. A price without its unit is the rule-90 trap.
 */

import { getPoolsFunClient } from "@tools/pools-fun/client.js";
import type { PoolsCandleTimeframe } from "@tools/pools-fun/constants.js";
import {
  POOLS_CANDLE_AGGREGATE_CAP,
  POOLS_CANDLE_LIMIT_CAP,
  POOLS_CANDLE_TIMEFRAMES,
  POOLS_CHAIN_SLUG,
} from "@tools/pools-fun/constants.js";
import type { PoolsCandle } from "@tools/pools-fun/types.js";
import { ok, fail } from "../../handler-helpers.js";
import { readEnum, readNumber } from "../../runtime/list-params.js";
import type { NumericParamSpecs } from "../../runtime/list-params.js";
import { poolsFailureDetail } from "./failure.js";
import { isEvmAddress } from "./project.js";
import type { ProtocolExecutionContext } from "../../types.js";

const CANDLES_NUMERIC_PARAMS: NumericParamSpecs = {
  aggregate: { domain: "nonNegative", integer: true, min: 1, max: POOLS_CANDLE_AGGREGATE_CAP },
  limit: { domain: "nonNegative", integer: true, min: 1, max: POOLS_CANDLE_LIMIT_CAP },
};

const DEFAULT_LIMIT = 30;
const DEFAULT_AGGREGATE = 1;

export type CandleOrder = "oldest-first" | "newest-first" | "single" | "empty" | "unordered";

/**
 * Read the ordering off the data instead of asserting one.
 *
 * `unordered` is a real answer, not a fallback: a series whose timestamps neither
 * ascend nor descend is not something to relabel as one of the two, and the
 * agent is better served knowing the provider sent something it cannot trust to
 * be a sequence.
 */
export function describeCandleOrder(candles: readonly PoolsCandle[]): CandleOrder {
  if (candles.length === 0) return "empty";
  if (candles.length === 1) return "single";
  let ascending = true;
  let descending = true;
  for (let i = 1; i < candles.length; i += 1) {
    const previous = candles[i - 1]!.time;
    const current = candles[i]!.time;
    if (current < previous) ascending = false;
    if (current > previous) descending = false;
  }
  if (ascending) return "oldest-first";
  if (descending) return "newest-first";
  return "unordered";
}

export async function poolsCandlesHandler(
  p: Record<string, unknown>,
  context: ProtocolExecutionContext,
) {
  const tokenAddress = typeof p.tokenAddress === "string" ? p.tokenAddress.trim() : "";
  if (!tokenAddress) {
    return fail("Missing required: tokenAddress (the contract address of the pools.fun token).");
  }
  // Checked locally: a symbol or a typo here becomes a path segment, and the
  // provider answers an unresolvable one with a 502 that this tool reports as
  // "no pool for this token" - true of the string sent, and misleading about
  // the token the user meant.
  if (!isEvmAddress(tokenAddress)) {
    return fail(
      `"tokenAddress" must be a contract address (0x followed by 40 hex characters), received "${tokenAddress}". `
        + "Resolve a name or symbol to an address with pools__tokens_search first.",
    );
  }

  const timeframeRead = readEnum<PoolsCandleTimeframe>(p, "timeframe", POOLS_CANDLE_TIMEFRAMES, "hour");
  if (!timeframeRead.ok) return fail(timeframeRead.reason);
  const aggregateRead = readNumber(p, "aggregate", CANDLES_NUMERIC_PARAMS);
  if (!aggregateRead.ok) return fail(aggregateRead.reason);
  const limitRead = readNumber(p, "limit", CANDLES_NUMERIC_PARAMS);
  if (!limitRead.ok) return fail(limitRead.reason);

  const aggregate = aggregateRead.value ?? DEFAULT_AGGREGATE;
  const limit = limitRead.value ?? DEFAULT_LIMIT;

  try {
    const result = await getPoolsFunClient().candles(
      {
        tokenAddress,
        timeframe: timeframeRead.value,
        aggregate,
        limit,
      },
      { signal: context.abortSignal },
    );

    return ok({
      chain: POOLS_CHAIN_SLUG,
      token: tokenAddress,
      pool: result.pool?.address ?? null,
      pair: result.pair
        ? { base: result.pair.baseSymbol, quote: result.pair.quoteSymbol }
        : null,
      timeframe: timeframeRead.value,
      aggregate,
      count: result.candles.length,
      order: describeCandleOrder(result.candles),
      // Named, not positional. `open` and `close` are one array slot apart on
      // the wire and nothing in the numbers would reveal a swap.
      candles: result.candles,
      priceUnit: result.pair?.quoteSymbol ?? null,
      note: "Candle prices are display-grade and quoted in the pool's quote asset (see priceUnit); "
        + "volumeUsd is in US dollars. Read the order field rather than assuming which end is newest.",
    });
  } catch (err) {
    return fail(`pools.fun candles unavailable (${poolsFailureDetail("pools__token_candles_list", err)})`);
  }
}
