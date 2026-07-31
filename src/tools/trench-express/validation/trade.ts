/**
 * Trade validator for `/api/trades` (undocumented endpoint).
 *
 * Items carry NO `token` field — the token is the query parameter. `type`,
 * `tx`, `time` and the amounts (`in`/`out`/`vol`/`price`) are required; `_id`
 * and `maker` are display-tolerant.
 */

import { z } from "zod";
import type { TrenchTrade } from "../types.js";
import { displayString, financialNumber, parseOrThrow } from "./_shared.js";

const trenchTradeSchema: z.ZodType<TrenchTrade> = z.object({
  type: financialNumber,
  in: financialNumber,
  out: financialNumber,
  vol: financialNumber,
  price: financialNumber,
  tx: z.string().min(1, { error: "expected a transaction hash" }),
  time: financialNumber,
  _id: displayString,
  maker: displayString,
});

const tradeListSchema = z.array(trenchTradeSchema);

/** Validate a `/api/trades` array response. */
export function validateTrades(raw: unknown): TrenchTrade[] {
  return parseOrThrow(tradeListSchema, raw);
}
