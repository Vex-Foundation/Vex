/**
 * `pendle.market.history` — the APY / TVL / price series behind one market.
 *
 * This is the read a fixed-yield decision actually turns on: an implied APY is
 * only high or low relative to where it has been, and before this tool the agent
 * could see today's number and nothing else (G-06). Every value leaves with its
 * unit in the field NAME — Pendle returns APYs as decimal fractions (0.0228 =
 * 2.28%) and a bare 0.0228 in agent-facing output is a unit trap.
 *
 * The statistics are computed HERE rather than asked of the provider, because
 * the provider does not offer them and an agent should not have to reduce a
 * 1,440-row series itself to learn whether a rate rose or fell.
 *
 * Field selection is explicit on every call. The provider's default set costs
 * four times the compute units of a narrow window and returns fields nobody
 * asked for; `market-read-params.ts` holds the closed allowlist, live-verified
 * field by field, because the endpoint answers HTTP 400 for the rest.
 */

import { getPendleReadClient } from "@tools/pendle/read/client.js";
import type { PendleReadHistoryField, PendleReadMarketHistoryPoint } from "@tools/pendle/read/types.js";
import { pendleChainSlug } from "@tools/pendle/chains.js";
import { VexError } from "../../../../../errors.js";
import type { ToolResult } from "../../../types.js";
import { ok, fail } from "../../handler-helpers.js";
import { percentString, usdString } from "../money-format.js";
import { PENDLE_READ_MAX_SERIES_POINTS, parsePendleMarketHistoryParams } from "../market-read-params.js";
import { trustedIsoTimestamp, trustedNumber } from "../trusted-fields.js";
import { failureDetail } from "./read-shared.js";

const TOOL_ID = "pendle.market.history";

/** How each provider field is named and formatted once it faces the agent. */
type HistoryFieldUnit = "percent" | "usd" | "quantity";

const HISTORY_FIELD_OUTPUT: Record<PendleReadHistoryField, { key: string; unit: HistoryFieldUnit }> = {
  impliedApy: { key: "impliedApyPercent", unit: "percent" },
  underlyingApy: { key: "underlyingApyPercent", unit: "percent" },
  maxApy: { key: "maxApyPercent", unit: "percent" },
  baseApy: { key: "baseApyPercent", unit: "percent" },
  pendleApy: { key: "pendleApyPercent", unit: "percent" },
  aggregatedApy: { key: "aggregatedApyPercent", unit: "percent" },
  swapFeeApy: { key: "swapFeeApyPercent", unit: "percent" },
  ytFloatingApy: { key: "ytFloatingApyPercent", unit: "percent" },
  tvl: { key: "tvlUsd", unit: "usd" },
  ptPrice: { key: "ptPriceUsd", unit: "usd" },
  ytPrice: { key: "ytPriceUsd", unit: "usd" },
  lpPrice: { key: "lpPriceUsd", unit: "usd" },
  tradingVolume: { key: "tradingVolumeUsd", unit: "usd" },
  // Pool composition, already in human units on this endpoint (not base units).
  totalPt: { key: "totalPt", unit: "quantity" },
  totalSy: { key: "totalSy", unit: "quantity" },
  totalSupply: { key: "totalSupply", unit: "quantity" },
  totalActiveSupply: { key: "totalActiveSupply", unit: "quantity" },
};

/** APY bound is 100 (=10,000%); USD and pool quantities get the default bound. */
function format(value: number, unit: HistoryFieldUnit): string | number | null {
  if (unit === "percent") return percentString(trustedNumber(value, 100));
  if (unit === "usd") return usdString(trustedNumber(value));
  return trustedNumber(value);
}

interface FieldStats {
  min: string | number | null;
  max: string | number | null;
  first: string | number | null;
  last: string | number | null;
  /**
   * Relative change from the first point to the last, in percent. Null when the
   * first value is zero — a change against nothing is undefined, and emitting
   * "Infinity" or 0 there would be a claim the data does not support.
   */
  changePercent: string | null;
}

function statsFor(values: readonly number[], unit: HistoryFieldUnit): FieldStats | null {
  const first = values[0];
  const last = values[values.length - 1];
  if (first === undefined || last === undefined) return null;
  return {
    min: format(Math.min(...values), unit),
    max: format(Math.max(...values), unit),
    first: format(first, unit),
    last: format(last, unit),
    changePercent: first === 0 ? null : (((last - first) / Math.abs(first)) * 100).toFixed(2),
  };
}

/**
 * Keep the MOST RECENT points when a series exceeds the bound.
 *
 * The window guard refuses an over-long request up front, so this only fires on
 * an open-ended window. Keeping the tail rather than the head is the useful half
 * of a trend, and the choice is stated in the output rather than left implicit.
 */
function boundPoints(points: readonly PendleReadMarketHistoryPoint[]): {
  kept: readonly PendleReadMarketHistoryPoint[];
  truncated: boolean;
} {
  if (points.length <= PENDLE_READ_MAX_SERIES_POINTS) return { kept: points, truncated: false };
  return { kept: points.slice(points.length - PENDLE_READ_MAX_SERIES_POINTS), truncated: true };
}

export async function pendleMarketHistory(
  p: Record<string, unknown>,
  nowMs: number = Date.now(),
): Promise<ToolResult> {
  const parsed = parsePendleMarketHistoryParams(p, nowMs);
  if (!parsed.ok) return fail(parsed.rejection.message);
  const q = parsed.value;
  const chain = pendleChainSlug(q.chainId) ?? String(q.chainId);

  let series;
  try {
    series = await getPendleReadClient().getMarketHistory(q.chainId, q.market, {
      timeFrame: q.timeFrame,
      fields: q.fields,
      ...(q.fromIso === undefined ? {} : { timestampStart: q.fromIso }),
      ...(q.toIso === undefined ? {} : { timestampEnd: q.toIso }),
    });
  } catch (err) {
    if (err instanceof VexError && err.httpStatus === 404) {
      return fail(
        `Pendle serves no historical data for ${q.market} on ${chain} (it answered 404). Confirm the market with ` +
          "pendle.market.get — the same address on another chain is a different asset — rather than requesting it again.",
      );
    }
    return fail(`Pendle market history unavailable (${failureDetail(TOOL_ID, err)})`);
  }

  const { kept, truncated } = boundPoints(series.points);
  const rows: Array<Record<string, unknown>> = [];
  const seriesValues = new Map<PendleReadHistoryField, number[]>();

  for (const point of kept) {
    const timestamp = trustedIsoTimestamp(point.timestamp);
    if (timestamp === null) continue;
    const row: Record<string, unknown> = { timestamp };
    for (const field of q.fields) {
      const value = point.values[field];
      if (value === undefined) continue;
      const output = HISTORY_FIELD_OUTPUT[field];
      row[output.key] = format(value, output.unit);
      const collected = seriesValues.get(field) ?? [];
      collected.push(value);
      seriesValues.set(field, collected);
    }
    rows.push(row);
  }

  const stats: Record<string, FieldStats> = {};
  for (const field of q.fields) {
    const values = seriesValues.get(field);
    const output = HISTORY_FIELD_OUTPUT[field];
    const computed = values === undefined ? null : statsFor(values, output.unit);
    if (computed !== null) stats[output.key] = computed;
  }

  return ok({
    summary: summarize(chain, q.timeFrame, rows.length, stats),
    chain,
    market: q.market,
    timeFrame: q.timeFrame,
    fields: q.fields.map((field) => HISTORY_FIELD_OUTPUT[field].key),
    requestedWindow: { from: q.fromIso ?? null, to: q.toIso ?? null },
    /** What the provider says it actually applied — not necessarily what was asked. */
    appliedWindow: { from: series.timestampStart, to: series.timestampEnd },
    count: rows.length,
    total: series.total,
    truncated,
    ...(truncated
      ? {
          truncationNote:
            `The series held more than ${PENDLE_READ_MAX_SERIES_POINTS} points; the MOST RECENT ${PENDLE_READ_MAX_SERIES_POINTS} ` +
            "are shown and the older ones are not. Narrow `from`/`to`, or use a coarser `timeFrame`, to see them.",
        }
      : {}),
    points: rows,
    stats,
    asOf: new Date(nowMs).toISOString(),
    nextStep:
      "`stats.changePercent` is the relative move from the first point to the last, not an APY. For the market's " +
      "identity, accepted tokens and current rates call pendle.market.get; for the PT/YT/LP price candles behind these " +
      "numbers call pendle.market.candles. A high implied APY on a thin market is not an opportunity — check tvlUsd too.",
  });
}

function summarize(chain: string, timeFrame: string, count: number, stats: Record<string, FieldStats>): string {
  if (count === 0) {
    return `Pendle returned no points for this market on ${chain} in the requested ${timeFrame} window.`;
  }
  const implied = stats.impliedApyPercent;
  const headline =
    implied === undefined
      ? ""
      : ` Implied APY went ${implied.first}% → ${implied.last}%` +
        (implied.changePercent === null ? "." : ` (${implied.changePercent}% relative).`);
  return `${count} ${timeFrame} point${count === 1 ? "" : "s"} on ${chain}.${headline}`;
}
