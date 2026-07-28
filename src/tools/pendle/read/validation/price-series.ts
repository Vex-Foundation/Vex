/**
 * Price reads:
 *   GET /v4/{chainId}/prices/{asset}/ohlcv  → candles, shipped as CSV in JSON
 *   GET /v1/prices/assets                   → USD snapshot, shipped as a MAP
 *
 * Both endpoints answer with a container that is not what its name suggests, and
 * both mistakes are the kind that reads as "no data" rather than as a parse
 * failure. They share a module because both are price snapshots and both are
 * display-only: neither may become a pre-trade rate (that is `swapping-prices`).
 */

import { pendleInvalidResponse } from "../../errors.js";
import type {
  PendleReadAssetPrice,
  PendleReadAssetPrices,
  PendleReadCandle,
  PendleReadCandles,
  PendleReadTimeFrame,
} from "../types.js";
import {
  chainIdFromCompositeId,
  isRecord,
  readDisplayNumber,
  readDisplayString,
  requireAddress,
  requireFiniteNumber,
} from "./_shared.js";

const OHLCV_ENDPOINT = "asset ohlcv";
const ASSET_PRICES_ENDPOINT = "asset prices";

/**
 * Hard ceiling on candles decoded from one response.
 *
 * The endpoint has no server-side row cap of its own — an hourly window over a
 * year is ~8,760 rows — so the bound is ours. 1,440 is 60 days of hourly, 4
 * years of daily, or a full day of minute data: past any window a read tool
 * should be asking for in one call.
 */
export const PENDLE_READ_MAX_CANDLE_ROWS = 1440;

/** The exact CSV header the endpoint documents and live-returns, in order. */
const OHLCV_COLUMNS = ["time", "open", "high", "low", "close", "volume"] as const;

const TIME_FRAMES: readonly PendleReadTimeFrame[] = ["hour", "day", "week"];

function readTimeFrame(v: unknown): PendleReadTimeFrame | null {
  const raw = readDisplayString(v);
  return raw !== null && (TIME_FRAMES as readonly string[]).includes(raw) ? (raw as PendleReadTimeFrame) : null;
}

/** Parse one CSV cell as a finite number. Empty/whitespace is "absent", not zero. */
function parseCell(cell: string | undefined): number | null {
  if (cell === undefined) return null;
  const trimmed = cell.trim();
  if (trimmed.length === 0) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseCandleRow(line: string, rowIndex: number): PendleReadCandle {
  const cells = line.split(",");
  const time = parseCell(cells[0]);
  const open = parseCell(cells[1]);
  const high = parseCell(cells[2]);
  const low = parseCell(cells[3]);
  const close = parseCell(cells[4]);
  if (time === null || open === null || high === null || low === null || close === null) {
    // A candle with a guessed price is a lie about a market. Refuse the body.
    throw pendleInvalidResponse(OHLCV_ENDPOINT, `CSV row ${rowIndex} carried a non-numeric time or price column`);
  }
  return {
    time,
    open,
    high,
    low,
    close,
    // Volume is legitimately EMPTY on candles with no recorded trades (live), so
    // it alone is allowed to be absent — and stays null rather than becoming 0,
    // which would read as "measured zero volume".
    volume: parseCell(cells[5]),
  };
}

/**
 * `GET /v4/{chainId}/prices/{asset}/ohlcv` → typed candles.
 *
 * SHAPE NOTE (live-verified 2026-07-27): `results` is a CSV STRING inside the
 * JSON body, with a header line, unix-SECOND timestamps, and an empty trailing
 * volume column on some rows. `timestamp_start`/`timestamp_end` on this endpoint
 * are unix seconds, unlike the ISO strings the market history endpoint returns.
 *
 * The parse is BOUNDED: at most `PENDLE_READ_MAX_CANDLE_ROWS` rows are decoded
 * and `truncated` reports it, so a caller can narrow the window instead of
 * silently receiving a prefix (owner rule: outputs are never silently truncated).
 */
export function validatePendleCandles(raw: unknown): PendleReadCandles {
  if (!isRecord(raw)) {
    throw pendleInvalidResponse(OHLCV_ENDPOINT, "expected a JSON object at the root");
  }
  const csv = raw.results;
  if (typeof csv !== "string") {
    throw pendleInvalidResponse(OHLCV_ENDPOINT, "`results` was not the documented CSV string");
  }
  const total = readDisplayNumber(raw.total);
  if (total === null) {
    throw pendleInvalidResponse(OHLCV_ENDPOINT, "the root carried no readable `total`");
  }

  const lines = csv.split("\n").filter((line) => line.trim().length > 0);
  const header = lines[0];
  if (header === undefined || header.split(",").map((c) => c.trim()).join(",") !== OHLCV_COLUMNS.join(",")) {
    throw pendleInvalidResponse(OHLCV_ENDPOINT, "the CSV header was not the documented time,open,high,low,close,volume");
  }

  const rows = lines.slice(1);
  const decodeCount = Math.min(rows.length, PENDLE_READ_MAX_CANDLE_ROWS);
  const candles: PendleReadCandle[] = [];
  for (let i = 0; i < decodeCount; i += 1) {
    candles.push(parseCandleRow(rows[i]!, i + 1));
  }

  return {
    currency: readDisplayString(raw.currency),
    timeFrame: readTimeFrame(raw.timeFrame),
    total,
    candles,
    truncated: rows.length > decodeCount,
  };
}

/**
 * `GET /v1/prices/assets` → USD snapshot rows.
 *
 * SHAPE NOTE (live-verified 2026-07-27): `prices` is a MAP keyed by the
 * `chainId-address` composite (`{"1-0x…": 1872.59}`), NOT an array of rows. An
 * entry whose key or value is unreadable is DROPPED rather than priced at 0 —
 * an invented $0 is how an unpriceable position becomes an invisible one.
 *
 * These are ~15-60 s snapshots. They are for display and portfolio arithmetic,
 * never a pre-trade rate.
 */
export function validatePendleAssetPrices(raw: unknown): PendleReadAssetPrices {
  if (!isRecord(raw)) {
    throw pendleInvalidResponse(ASSET_PRICES_ENDPOINT, "expected a JSON object at the root");
  }
  const priceMap = raw.prices;
  if (!isRecord(priceMap)) {
    throw pendleInvalidResponse(ASSET_PRICES_ENDPOINT, "the root carried no `prices` object");
  }

  const entries = Object.entries(priceMap);
  const prices: PendleReadAssetPrice[] = [];
  for (const [id, value] of entries) {
    const chainId = chainIdFromCompositeId(id);
    const address = requireAddress(id);
    const priceUsd = requireFiniteNumber(value);
    if (chainId === null || address === null || priceUsd === null) continue;
    prices.push({ chainId, address, priceUsd });
  }
  if (prices.length === 0 && entries.length > 0) {
    throw pendleInvalidResponse(ASSET_PRICES_ENDPOINT, "no entry carried a readable `chainId-address` key and price");
  }

  return {
    total: readDisplayNumber(raw.total) ?? prices.length,
    skip: readDisplayNumber(raw.skip) ?? 0,
    prices,
  };
}
