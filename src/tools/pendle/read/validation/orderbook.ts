/**
 * `GET /v2/limit-orders/book/{chainId}` — merged limit-order (and optionally
 * AMM) yield depth for ONE market.
 *
 * Read-only by decision (owner Q21): the maker surface and its EIP-712 signing
 * primitive stay out of scope. This is the depth an agent is currently blind to
 * while every convert quote pins `useLimitOrder: false`.
 *
 * Live behaviour worth knowing (verified 2026-07-27): a market that is not
 * limit-order whitelisted answers HTTP 404 (`Can not find supportToken by market
 * address`), NOT an empty book — the deepest chain-1 market is one such. The
 * client maps that before this validator runs, so an empty book here really does
 * mean "whitelisted, no resting depth".
 */

import { pendleInvalidResponse } from "../../errors.js";
import type { PendleReadOrderbook, PendleReadOrderbookLevel } from "../types.js";
import { isRecord, requireDigitString, requireFiniteNumber } from "./_shared.js";

const ENDPOINT = "limit-order book";

function normalizeLevel(raw: unknown): PendleReadOrderbookLevel | null {
  if (!isRecord(raw)) return null;
  const impliedApy = requireFiniteNumber(raw.impliedApy);
  // STRICT: sizes are raw base-unit u256 strings of the market's PY unit. They
  // travel WITHOUT decimals on this endpoint, so a consumer must resolve those
  // from the asset catalogue — but a size we cannot even read as base units
  // could never be resolved at all, so the level is dropped.
  const limitOrderSizeRaw = requireDigitString(raw.limitOrderSize);
  if (impliedApy === null || limitOrderSizeRaw === null) return null;

  return {
    impliedApy,
    limitOrderSizeRaw,
    // Present only when the request asked for `includeAmm`.
    ammSizeRaw: requireDigitString(raw.ammSize),
    incentiveQualifiedPySizeRaw: requireDigitString(raw.incentiveQualifiedPySize),
  };
}

function normalizeSide(raw: unknown, side: string): PendleReadOrderbookLevel[] {
  if (!Array.isArray(raw)) {
    throw pendleInvalidResponse(ENDPOINT, `\`${side}\` was absent or not an array`);
  }
  const levels = raw.map(normalizeLevel).filter((l): l is PendleReadOrderbookLevel => l !== null);
  if (levels.length === 0 && raw.length > 0) {
    throw pendleInvalidResponse(ENDPOINT, `no \`${side}\` level carried a readable implied APY and raw size`);
  }
  return levels;
}

/**
 * `GET /v2/limit-orders/book/{chainId}?market=…&precisionDecimal=…` → both sides.
 *
 * Both documented sides must be present. An empty side is a determined answer; a
 * body we cannot read RAISES, so "no depth" can never come from a parse failure.
 */
export function validatePendleOrderbook(raw: unknown): PendleReadOrderbook {
  if (!isRecord(raw)) {
    throw pendleInvalidResponse(ENDPOINT, "expected a JSON object at the root");
  }
  return {
    longYieldEntries: normalizeSide(raw.longYieldEntries, "longYieldEntries"),
    shortYieldEntries: normalizeSide(raw.shortYieldEntries, "shortYieldEntries"),
  };
}
