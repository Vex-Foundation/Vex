/**
 * Order validator — `/orders/v1/{chainId}/{tokenAddress}`.
 *
 * The live root is an OBJECT, `{orders, boosts}` — not an array. Requiring an
 * array made `dexscreener.orders` fail on 100% of calls, and discarded two
 * things worth having: the sibling boost-PAYMENT ledger, and the `chainId` /
 * `tokenAddress` each row carries.
 *
 * IDENTITY STRICT, DISPLAY TOLERANT, same posture as the boost feed. An order
 * row must carry a readable `type` and `status` — those two ARE the answer the
 * tool exists to give, so a row without them says nothing. A ledger row must
 * carry at least one readable payment fact (`amount` or timestamp). Everything
 * else is nullable, and rows failing the test are skipped and COUNTED rather
 * than throwing the whole response away.
 */

import { VexError, ErrorCodes } from "../../../errors.js";
import { isRecord } from "../../../utils/validation-helpers.js";
import type { DexBoostPayment, DexOrder, DexOrdersResponse } from "../types.js";

/** Non-empty string, else `null`. */
function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Real number (NaN excluded, ±Infinity accepted as elsewhere in this module), else `null`. */
function optionalNumber(value: unknown): number | null {
  return typeof value === "number" && !Number.isNaN(value) ? value : null;
}

/** One paid promotional order. `null` when the row carries no readable type+status. */
function parseOrder(raw: unknown): DexOrder | null {
  if (!isRecord(raw)) return null;
  const type = optionalString(raw.type);
  const status = optionalString(raw.status);
  if (type === null || status === null) return null;
  return {
    chainId: optionalString(raw.chainId) ?? "",
    tokenAddress: optionalString(raw.tokenAddress) ?? "",
    type,
    status,
    // Live: 13-digit epoch MILLISECONDS. Renamed from the provider's
    // `paymentTimestamp` so the unit cannot be guessed wrong downstream.
    paymentTimestampMs: optionalNumber(raw.paymentTimestamp),
  };
}

/** One boost purchase. `null` when the row carries no readable payment fact. */
function parseBoostPayment(raw: unknown): DexBoostPayment | null {
  if (!isRecord(raw)) return null;
  const amount = optionalNumber(raw.amount);
  const paymentTimestampMs = optionalNumber(raw.paymentTimestamp);
  if (amount === null && paymentTimestampMs === null) return null;
  return {
    chainId: optionalString(raw.chainId) ?? "",
    tokenAddress: optionalString(raw.tokenAddress) ?? "",
    id: optionalString(raw.id),
    amount,
    paymentTimestampMs,
  };
}

export function validateOrdersResponse(raw: unknown): DexOrdersResponse {
  if (!isRecord(raw)) {
    throw new VexError(
      ErrorCodes.DEXSCREENER_INVALID_RESPONSE,
      "Invalid DexScreener response: expected orders response object",
    );
  }
  // An ABSENT collection is legitimate (a token with no boost history sends
  // `"boosts": []`, and neither key is guaranteed forever); a PRESENT
  // non-array one is a shape error we must not paper over.
  if (raw.orders !== undefined && !Array.isArray(raw.orders)) {
    throw new VexError(
      ErrorCodes.DEXSCREENER_INVALID_RESPONSE,
      "Invalid DexScreener response: expected orders array in orders response",
    );
  }
  if (raw.boosts !== undefined && !Array.isArray(raw.boosts)) {
    throw new VexError(
      ErrorCodes.DEXSCREENER_INVALID_RESPONSE,
      "Invalid DexScreener response: expected boosts array in orders response",
    );
  }

  const rawOrders: unknown[] = Array.isArray(raw.orders) ? raw.orders : [];
  const rawBoosts: unknown[] = Array.isArray(raw.boosts) ? raw.boosts : [];

  const orders: DexOrder[] = [];
  let skippedOrders = 0;
  for (const row of rawOrders) {
    const parsed = parseOrder(row);
    if (parsed === null) skippedOrders += 1;
    else orders.push(parsed);
  }

  const boostPayments: DexBoostPayment[] = [];
  let skippedBoostPayments = 0;
  for (const row of rawBoosts) {
    const parsed = parseBoostPayment(row);
    if (parsed === null) skippedBoostPayments += 1;
    else boostPayments.push(parsed);
  }

  return { orders, boostPayments, skippedOrders, skippedBoostPayments };
}
