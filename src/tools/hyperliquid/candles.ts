import { z } from "zod";
import { Decimal } from "decimal.js";

import { normalizeProviderDecimal } from "./validation.js";

export const HYPERLIQUID_CANDLE_INTERVALS = ["1m", "5m", "15m", "1h", "4h", "1d"] as const;
export type HyperliquidCandleInterval = (typeof HYPERLIQUID_CANDLE_INTERVALS)[number];

export const hyperliquidCandleIntervalSchema = z.enum(HYPERLIQUID_CANDLE_INTERVALS);

const candlePayloadSchema = z.object({
  t: z.number().int().nonnegative(),
  s: z.string().trim().min(1).max(64),
  i: hyperliquidCandleIntervalSchema,
  o: z.string(),
  h: z.string(),
  l: z.string(),
  c: z.string(),
  v: z.string(),
}).passthrough();

export interface HyperliquidCandle {
  readonly coin: string;
  readonly interval: HyperliquidCandleInterval;
  readonly openTimeMs: number;
  readonly open: string;
  readonly high: string;
  readonly low: string;
  readonly close: string;
  readonly volume: string;
}

/** Validates and canonicalizes an untrusted venue snapshot or websocket event. */
export function parseHyperliquidCandle(value: unknown): HyperliquidCandle {
  const candle = candlePayloadSchema.parse(value);
  const parsed = {
    coin: candle.s.toUpperCase(),
    interval: candle.i,
    openTimeMs: candle.t,
    open: normalizeProviderDecimal(candle.o, "Candle open"),
    high: normalizeProviderDecimal(candle.h, "Candle high"),
    low: normalizeProviderDecimal(candle.l, "Candle low"),
    close: normalizeProviderDecimal(candle.c, "Candle close"),
    volume: normalizeProviderDecimal(candle.v, "Candle volume"),
  };
  const open = new Decimal(parsed.open); const high = new Decimal(parsed.high);
  const low = new Decimal(parsed.low); const close = new Decimal(parsed.close);
  if (open.lte(0) || high.lte(0) || low.lte(0) || close.lte(0) || high.lt(low) || high.lt(open) || high.lt(close) || low.gt(open) || low.gt(close)) {
    throw new Error("Malformed candle OHLC values.");
  }
  return parsed;
}

export const HYPERLIQUID_CANDLE_WINDOWS_MS: Readonly<Record<HyperliquidCandleInterval, number>> = {
  "1m": 6 * 60 * 60 * 1_000,
  "5m": 24 * 60 * 60 * 1_000,
  "15m": 3 * 24 * 60 * 60 * 1_000,
  "1h": 7 * 24 * 60 * 60 * 1_000,
  "4h": 30 * 24 * 60 * 60 * 1_000,
  "1d": 180 * 24 * 60 * 60 * 1_000,
};
