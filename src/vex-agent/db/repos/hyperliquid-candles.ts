import { execute, query, queryOne, withTransaction } from "../client.js";
import type { HyperliquidCandle } from "@tools/hyperliquid/candles.js";

export const HYPERLIQUID_CANDLE_RING_SIZE = 5_000;

export interface HyperliquidCandleRow extends HyperliquidCandle {
  readonly updatedAt: string;
}

export interface HyperliquidCandleWatch {
  readonly coin: string;
  readonly interval: HyperliquidCandle["interval"];
  readonly enabled: boolean;
  readonly updatedAt: string;
}

interface CandleDbRow {
  readonly coin: string;
  readonly interval: HyperliquidCandle["interval"];
  readonly open_time_ms: string | number;
  readonly open: string;
  readonly high: string;
  readonly low: string;
  readonly close: string;
  readonly volume: string;
  readonly updated_at: string | Date;
}

interface WatchDbRow {
  readonly coin: string;
  readonly interval: HyperliquidCandle["interval"];
  readonly enabled: boolean;
  readonly updated_at: string | Date;
}

function iso(value: string | Date): string { return value instanceof Date ? value.toISOString() : value; }
function candle(row: CandleDbRow): HyperliquidCandleRow {
  return {
    coin: row.coin, interval: row.interval, openTimeMs: Number(row.open_time_ms),
    open: row.open, high: row.high, low: row.low, close: row.close, volume: row.volume,
    updatedAt: iso(row.updated_at),
  };
}
function watch(row: WatchDbRow): HyperliquidCandleWatch {
  return { coin: row.coin, interval: row.interval, enabled: row.enabled, updatedAt: iso(row.updated_at) };
}

/** Persist a watch state. Callers enforce the watch limit before enabling. */
export async function setHyperliquidCandleWatch(input: {
  coin: string;
  interval: HyperliquidCandle["interval"];
  enabled: boolean;
}): Promise<HyperliquidCandleWatch> {
  const row = await queryOne<WatchDbRow>(
    `INSERT INTO hyperliquid_candle_watches (coin, interval, enabled)
     VALUES ($1, $2, $3)
     ON CONFLICT (coin, interval) DO UPDATE
       SET enabled = EXCLUDED.enabled, updated_at = NOW()
     RETURNING coin, interval, enabled, updated_at`,
    [input.coin, input.interval, input.enabled],
  );
  if (row === null) throw new Error("Could not persist Hyperliquid candle watch.");
  return watch(row);
}

export async function getHyperliquidCandleWatch(coin: string, interval: HyperliquidCandle["interval"]): Promise<HyperliquidCandleWatch | null> {
  const row = await queryOne<WatchDbRow>(
    `SELECT coin, interval, enabled, updated_at FROM hyperliquid_candle_watches
      WHERE coin = $1 AND interval = $2`,
    [coin, interval],
  );
  return row === null ? null : watch(row);
}

export async function listEnabledHyperliquidCandleWatches(): Promise<readonly HyperliquidCandleWatch[]> {
  const rows = await query<WatchDbRow>(
    `SELECT coin, interval, enabled, updated_at FROM hyperliquid_candle_watches
      WHERE enabled = TRUE ORDER BY updated_at ASC, coin ASC, interval ASC`,
  );
  return rows.map(watch);
}

export async function countEnabledHyperliquidCandleWatches(): Promise<number> {
  const row = await queryOne<{ readonly count: string | number }>("SELECT COUNT(*) AS count FROM hyperliquid_candle_watches WHERE enabled = TRUE");
  return Number(row?.count ?? 0);
}

/** Upsert a snapshot or live update, then enforce the per-pair ring bound atomically. */
export async function upsertHyperliquidCandles(rows: readonly HyperliquidCandle[]): Promise<void> {
  if (rows.length === 0) return;
  const first = rows[0];
  if (first === undefined) return;
  await withTransaction(async (client) => {
    for (const row of rows) {
      if (row.coin !== first.coin || row.interval !== first.interval) throw new Error("A candle write must contain exactly one coin/interval pair.");
      await client.query(
        `INSERT INTO hyperliquid_candles
          (coin, interval, open_time_ms, open, high, low, close, volume)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (coin, interval, open_time_ms) DO UPDATE SET
           open = EXCLUDED.open, high = EXCLUDED.high, low = EXCLUDED.low,
           close = EXCLUDED.close, volume = EXCLUDED.volume, updated_at = NOW()`,
        [row.coin, row.interval, row.openTimeMs, row.open, row.high, row.low, row.close, row.volume],
      );
    }
    await client.query(
      `DELETE FROM hyperliquid_candles
       WHERE coin = $1 AND interval = $2
         AND open_time_ms NOT IN (
           SELECT open_time_ms FROM hyperliquid_candles
            WHERE coin = $1 AND interval = $2
            ORDER BY open_time_ms DESC LIMIT $3
         )`,
      [first.coin, first.interval, HYPERLIQUID_CANDLE_RING_SIZE],
    );
  });
}

export async function readHyperliquidCandles(coin: string, interval: HyperliquidCandle["interval"], limit: number): Promise<readonly HyperliquidCandleRow[]> {
  const rows = await query<CandleDbRow>(
    `SELECT coin, interval, open_time_ms, open, high, low, close, volume, updated_at
       FROM hyperliquid_candles
      WHERE coin = $1 AND interval = $2
      ORDER BY open_time_ms DESC LIMIT $3`,
    [coin, interval, limit],
  );
  return rows.map(candle);
}

export async function deleteHyperliquidCandlesForPair(coin: string, interval: HyperliquidCandle["interval"]): Promise<number> {
  return execute("DELETE FROM hyperliquid_candles WHERE coin = $1 AND interval = $2", [coin, interval]);
}
