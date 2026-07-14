/**
 * Canonical unsigned candle decimal.
 *
 * Shared by the Hyperliquid candle IPC read (`ipc/hyperliquid.ts`) and the live
 * WebSocket feed (`market/hyperliquid-live-feed-service.ts`) so both canonicalize
 * open/high/low/close/volume identically before the strict candle DTO validates
 * them. Rejects non-finite or negative inputs (a candle price/volume can never be
 * negative); the caller drops the malformed row/event.
 */

import { Decimal } from "decimal.js";

export function canonicalCandleDecimal(value: string): string {
  const decimal = new Decimal(value);
  if (!decimal.isFinite() || decimal.isNegative()) throw new Error("invalid candle decimal");
  return decimal.toFixed();
}
