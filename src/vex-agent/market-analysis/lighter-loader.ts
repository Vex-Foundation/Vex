/**
 * Lighter candles for the analysis engine, perpetual and spot markets alike.
 *
 * Same open-timestamp contract the desk reads
 * (`vex-app/src/main/lighter/trading-panel-service.ts`): `t` is the candle's
 * OPEN time and `setTimestampToEnd: false` keeps it that way, so
 * `closeTime = t + intervalMs`. `V` (quote volume) is the volume carried.
 *
 * Two public reads, both under the client's per-environment public throttle:
 * the market's details (its symbol and type, and the proof it exists) and the
 * candles. No key, no account, no signing: the tool works while the vault is
 * locked, as `lighter.candles` does.
 */

import { getLighterClient } from "@tools/lighter/client.js";
import type { LighterEnvironment } from "@tools/lighter/constants.js";
import type { LighterCandle } from "@tools/lighter/types.js";
import { ANALYSIS_INTERVAL_MS } from "../../lib/market-analysis/result-schema.js";

import type { AnalysisBar, CandleLoadRequest, LoadCandles, LoadedCandles } from "./bars.js";

export interface LighterAnalysisMarket {
  readonly venue: "lighter";
  readonly environment: LighterEnvironment;
  readonly marketId: number;
  readonly symbol: string;
  readonly marketType: "perp" | "spot";
}

type LighterAnalysisClient = Pick<ReturnType<typeof getLighterClient>, "getCandles" | "getMarketDetails">;

/** Provider seconds become milliseconds, as the desk normalises them. */
function epochMs(value: number): number {
  return value < 1_000_000_000_000 ? value * 1_000 : value;
}

function toBar(candle: LighterCandle, intervalMs: number): AnalysisBar | null {
  const prices = [candle.o, candle.h, candle.l, candle.c];
  if (!Number.isFinite(candle.t) || !prices.every((value) => Number.isFinite(value) && value > 0)) {
    return null;
  }
  const openTime = epochMs(candle.t);
  return {
    openTime,
    closeTime: openTime + intervalMs,
    open: candle.o,
    high: candle.h,
    low: candle.l,
    close: candle.c,
    volume: Number.isFinite(candle.V) && candle.V >= 0 ? candle.V : null,
  };
}

export function createLighterCandleLoader(
  target: { readonly environment: LighterEnvironment; readonly marketId: number },
  client: LighterAnalysisClient = getLighterClient(),
  now: () => number = Date.now,
): LoadCandles<LighterAnalysisMarket> {
  return async (request: CandleLoadRequest): Promise<LoadedCandles<LighterAnalysisMarket>> => {
    const intervalMs = ANALYSIS_INTERVAL_MS[request.interval];
    const endTimestamp = request.untilMs ?? now();
    let details: Awaited<ReturnType<LighterAnalysisClient["getMarketDetails"]>>;
    let candles: Awaited<ReturnType<LighterAnalysisClient["getCandles"]>>;
    try {
      [details, candles] = await Promise.all([
        client.getMarketDetails(target.environment, { marketId: target.marketId, filter: "all" }),
        client.getCandles(target.environment, {
          marketId: target.marketId,
          resolution: request.interval,
          startTimestamp: endTimestamp - intervalMs * request.count,
          endTimestamp,
          countBack: request.count,
          // Provider `t` is the candle open timestamp. Keep REST and WS semantics equal.
          setTimestampToEnd: false,
        }),
      ]);
    } catch (cause) {
      return { ok: false, reason: "source_unavailable", detail: null, cause };
    }
    const fetchedAtMs = now();

    const detail = [...details.order_book_details, ...details.spot_order_book_details].find(
      (candidate) => candidate.market_id === target.marketId,
    );
    if (detail === undefined) {
      return {
        ok: false,
        reason: "market_not_found",
        detail: `Lighter has no market ${target.marketId} on ${target.environment}.`,
      };
    }

    const bars: AnalysisBar[] = [];
    let unpriced = 0;
    for (const candle of candles.c) {
      const bar = toBar(candle, intervalMs);
      if (bar === null) unpriced += 1;
      else bars.push(bar);
    }
    return {
      ok: true,
      market: {
        venue: "lighter",
        environment: target.environment,
        marketId: target.marketId,
        symbol: detail.symbol,
        marketType: detail.market_type,
      },
      bars,
      fetchedAtMs,
      unpriced,
      source: "live_lighter_public_api",
    };
  };
}
