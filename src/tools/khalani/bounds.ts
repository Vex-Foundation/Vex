/**
 * Khalani's DOCUMENTED request bounds, enforced before the wire (W2d).
 *
 * Khalani's integration guide states them and the API enforces them, but we
 * sent unchecked values: live 2026-08-03, `GET /v1/orders/<addr>?limit=100`
 * answered `HTTP 400 {"message":"Validation failed","name":"ValidationException",
 * "details":[{"field":"limit","message":"Too big: expected number to be <=20"}]}`.
 * A round-trip to learn a documented constant is a wasted call, a wasted second
 * and — before the `details[]` fix landed alongside this — an undiagnosable
 * "Validation failed" for the agent.
 *
 * Rejections NAME the parameter and the bound, so the agent can fix the call
 * rather than guess which of eight filters was wrong.
 */

import { VexError, ErrorCodes } from "../../errors.js";

/** `GET /v1/orders/{address}`: docs say default 10, max 20. */
export const KHALANI_ORDERS_LIMIT_MAX = 20;
/** `GET /v1/orders/{address}`: `txHashSearch` is capped at 66 characters (0x + 64 hex). */
export const KHALANI_TX_HASH_SEARCH_MAX_LENGTH = 66;
/** `GET /v1/tokens/autocomplete/{keyword}`: docs say 1–20, default 10. */
export const KHALANI_AUTOCOMPLETE_LIMIT_MIN = 1;
export const KHALANI_AUTOCOMPLETE_LIMIT_MAX = 20;

function reject(message: string): never {
  throw new VexError(
    ErrorCodes.KHALANI_VALIDATION_ERROR,
    message,
    "Fix the request parameters and retry.",
  );
}

function assertIntegerInRange(param: string, value: number, min: number, max: number): void {
  if (!Number.isInteger(value)) {
    reject(`Khalani rejects ${param}=${value}: it must be a whole number.`);
  }
  if (value < min || value > max) {
    reject(`Khalani rejects ${param}=${value}: the supported range is ${min}–${max}.`);
  }
}

/** Bounds for `getOrders` — validated together so ONE call names every problem it can. */
export function assertOrdersQueryBounds(opts: {
  limit?: number;
  txHashSearch?: string;
}): void {
  if (opts.limit !== undefined) {
    assertIntegerInRange("limit", opts.limit, 1, KHALANI_ORDERS_LIMIT_MAX);
  }
  if (opts.txHashSearch !== undefined && opts.txHashSearch.length > KHALANI_TX_HASH_SEARCH_MAX_LENGTH) {
    reject(
      `Khalani rejects txHashSearch: it is ${opts.txHashSearch.length} characters and the maximum `
      + `is ${KHALANI_TX_HASH_SEARCH_MAX_LENGTH}.`,
    );
  }
}

/** Bounds for `autocompleteToken`. */
export function assertAutocompleteLimit(limit: number | undefined): void {
  if (limit === undefined) return;
  assertIntegerInRange(
    "limit",
    limit,
    KHALANI_AUTOCOMPLETE_LIMIT_MIN,
    KHALANI_AUTOCOMPLETE_LIMIT_MAX,
  );
}
