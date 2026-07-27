/**
 * `pendle.market.candles` — OHLCV for one Pendle asset (PT, YT or LP).
 *
 * Three provider quirks are handled here rather than left for the agent, each
 * live-verified rather than read off the docs (G-07):
 *
 *  1. The candles arrive as a CSV STRING inside the JSON body. The read shelf
 *     decodes it under a hard row cap; this handler reports that cap as an
 *     explicit truncation rather than shipping a silent prefix.
 *  2. Row timestamps are unix SECONDS while the REQUEST window must be ISO — a
 *     seconds bound is a live 400. The window params here are ISO, matching
 *     `pendle.market.history`, and the rows are re-serialised to ISO so one tool
 *     never speaks two time formats.
 *  3. A candle with no trades carries an EMPTY volume column, and for LP assets
 *     Pendle documents volume on this endpoint as always 0. Both stay `null`
 *     with a sentence pointing at the market series for the real figure — a
 *     rendered 0 would read as a measured absence of trading.
 */

import { getPendleReadClient } from "@tools/pendle/read/client.js";
import type { PendleReadCandle } from "@tools/pendle/read/types.js";
import { pendleChainSlug } from "@tools/pendle/chains.js";
import { VexError } from "../../../../../errors.js";
import type { ToolResult } from "../../../types.js";
import { ok, fail } from "../../handler-helpers.js";
import { parsePendleMarketCandlesParams } from "../market-read-params.js";
import { trustedNumber } from "../trusted-fields.js";
import { failureDetail } from "./read-shared.js";

const TOOL_ID = "pendle.market.candles";

interface ProjectedCandle {
  /** ISO, re-serialised from the CSV's unix seconds so the output speaks one format. */
  time: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  volume: number | null;
}

function projectCandle(candle: PendleReadCandle): ProjectedCandle | null {
  const timeMs = candle.time * 1000;
  if (!Number.isFinite(timeMs)) return null;
  return {
    time: new Date(timeMs).toISOString(),
    open: trustedNumber(candle.open),
    high: trustedNumber(candle.high),
    low: trustedNumber(candle.low),
    close: trustedNumber(candle.close),
    volume: candle.volume === null ? null : trustedNumber(candle.volume),
  };
}

export async function pendleMarketCandles(
  p: Record<string, unknown>,
  nowMs: number = Date.now(),
): Promise<ToolResult> {
  const parsed = parsePendleMarketCandlesParams(p, nowMs);
  if (!parsed.ok) return fail(parsed.rejection.message);
  const q = parsed.value;
  const chain = pendleChainSlug(q.chainId) ?? String(q.chainId);

  let series;
  try {
    series = await getPendleReadClient().getAssetCandles(q.chainId, q.asset, {
      timeFrame: q.timeFrame,
      ...(q.fromIso === undefined ? {} : { timestampStart: q.fromIso }),
      ...(q.toIso === undefined ? {} : { timestampEnd: q.toIso }),
    });
  } catch (err) {
    if (err instanceof VexError && err.httpStatus === 404) {
      return fail(
        `Pendle serves no candles for ${q.asset} on ${chain} (it answered 404). This endpoint covers PT, YT and LP ` +
          "assets only — confirm the address with pendle.market.get, which lists a market's legs.",
      );
    }
    return fail(`Pendle candles unavailable (${failureDetail(TOOL_ID, err)})`);
  }

  const candles = series.candles.map(projectCandle).filter((c): c is ProjectedCandle => c !== null);
  const withoutVolume = candles.filter((c) => c.volume === null).length;
  const first = candles[0];
  const last = candles[candles.length - 1];

  return ok({
    summary: summarize(chain, q.timeFrame, candles.length, series.currency, first ?? null, last ?? null),
    chain,
    asset: q.asset,
    timeFrame: q.timeFrame,
    currency: series.currency,
    requestedWindow: { from: q.fromIso ?? null, to: q.toIso ?? null },
    count: candles.length,
    total: series.total,
    truncated: series.truncated,
    ...(series.truncated
      ? {
          truncationNote:
            "Pendle returned more rows than Vex decodes in one read. The rows shown are the start of the window, and " +
            "the rest are NOT included — narrow `from`/`to`, or use a coarser `timeFrame`.",
        }
      : {}),
    firstClose: first?.close ?? null,
    lastClose: last?.close ?? null,
    candlesWithoutVolume: withoutVolume,
    ...(withoutVolume > 0
      ? {
          volumeNote:
            `${withoutVolume} candle(s) carry no volume: Pendle leaves the column empty when there were no recorded ` +
            "trades in that bucket, and for LP assets it reports 0 here regardless. A null is NOT a measured zero. " +
            "For a market's real traded volume use pendle.market.history with the tradingVolume field.",
        }
      : {}),
    candles,
    asOf: new Date(nowMs).toISOString(),
    nextStep:
      "These are provider price marks for one asset, not executable quotes — a PT's price is what it last traded at, " +
      "not what you would receive. For the current rate call pendle.market.get, and for the APY/TVL series behind " +
      "these prices call pendle.market.history.",
  });
}

function summarize(
  chain: string,
  timeFrame: string,
  count: number,
  currency: string | null,
  first: ProjectedCandle | null,
  last: ProjectedCandle | null,
): string {
  if (count === 0 || first === null || last === null) {
    return `Pendle returned no ${timeFrame} candles for this asset on ${chain} in the requested window.`;
  }
  const unit = currency ?? "quote currency";
  return (
    `${count} ${timeFrame} candle${count === 1 ? "" : "s"} on ${chain}: ` +
    `close ${first.close ?? "?"} → ${last.close ?? "?"} ${unit} ` +
    `(${first.time.slice(0, 10)} → ${last.time.slice(0, 10)}).`
  );
}
