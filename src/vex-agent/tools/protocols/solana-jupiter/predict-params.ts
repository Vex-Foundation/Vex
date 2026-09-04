/**
 * Solana/Jupiter prediction-market request-param validation (F2).
 *
 * Extracted from `handlers/predict.ts` once its handler map pushed the file
 * over the factory's 500-line hard cap - a clean split by responsibility
 * (request-param validation vs. handler orchestration), not an arbitrary
 * line-count chop: `resolvePredictionWindow` was already exported and reused
 * by `handlers/predict-orders.ts` (W1-D); `strictEnumField` is reused by
 * `handlers/predict-social.ts` too (F2). One module now owns "how a raw
 * agent param becomes a validated, SDK-ready value" for every prediction
 * handler, mirroring the existing `predict-projector.ts` sibling (which owns
 * "how a raw SDK response becomes an agent-facing view").
 */

import type { ToolResult } from "../../types.js";
import { num, fail, enumField } from "../handler-helpers.js";

// ── Pagination window (W1-C) ──────────────────────────────────────
//
// events/positions/history/orders are Vex-side `limit`/`offset` abstractions
// over the SDK's index-based `start`/`end`. Factory owner rule: reject
// out-of-range limits with a clear error, never clamp silently (previously
// negative values were `Math.max(0, ...)`-clamped instead of rejected).
const PREDICT_DEFAULT_LIMIT = 20;
const PREDICT_MAX_LIMIT = 100;

export type PredictionWindowResult =
  | { readonly ok: true; readonly start: number; readonly end: number }
  | { readonly ok: false; readonly result: ToolResult };

/**
 * Resolve `limit`/`offset` into the SDK's `start`/`end` window for
 * events/positions/history (`handlers/predict.ts`) and orders (W1-D,
 * `handlers/predict-orders.ts`) - one shared reject-not-clamp validator
 * instead of a drifting per-file copy. Rejects (never clamps) an
 * out-of-range `limit` (integer, 1-100) or a negative `offset` with a clear,
 * handler-level error.
 */
export function resolvePredictionWindow(p: Record<string, unknown>): PredictionWindowResult {
  const limit = num(p, "limit");
  const offset = num(p, "offset");
  if (limit != null && (!Number.isInteger(limit) || limit < 1 || limit > PREDICT_MAX_LIMIT)) {
    return {
      ok: false,
      result: fail(`Invalid limit: ${limit}. limit must be an integer between 1 and ${PREDICT_MAX_LIMIT}.`),
    };
  }
  if (offset != null && (!Number.isInteger(offset) || offset < 0)) {
    return { ok: false, result: fail(`Invalid offset: ${offset}. offset must be a non-negative integer.`) };
  }
  const start = offset ?? 0;
  return { ok: true, start, end: start + (limit ?? PREDICT_DEFAULT_LIMIT) };
}

// ── /events/search local window (F2) ───────────────────────────────
//
// LIVE FACT (coordinator, 2026-07-24, 4s-spaced probing): `/events/search`
// ignores its own `limit` query param entirely - 1, 2, and 20 all returned
// the identical 10-row response. `resolvePredictionWindow`'s domain-wide
// 1-100 bound also does not apply here: search has its own stricter,
// SDK-validated 1-20 range (`validateJupiterPredictionSearchEventsParams`).
const SEARCH_DEFAULT_LIMIT = 20;
/** Exported so the search handler's truncation note names the same ceiling this rejects above. */
export const SEARCH_MAX_LIMIT = 20;

export type SearchWindowResult =
  | { readonly ok: true; readonly limit: number }
  | { readonly ok: false; readonly result: ToolResult };

/**
 * Resolve `.search`'s agent-requested result count. The handler still
 * validates + forwards `limit` to the SDK (so a future provider fix is a
 * no-op change on our side), but - because the provider ignores it live -
 * the handler enforces the agent's requested window LOCALLY by slicing the
 * response after the fact. Reject-not-clamp (owner rule): an out-of-range
 * value fails clearly instead of silently defaulting or being dropped.
 */
export function resolveSearchWindow(p: Record<string, unknown>): SearchWindowResult {
  const limit = num(p, "limit");
  if (limit != null && (!Number.isInteger(limit) || limit < 1 || limit > SEARCH_MAX_LIMIT)) {
    return {
      ok: false,
      result: fail(`Invalid limit: ${limit}. limit must be an integer between 1 and ${SEARCH_MAX_LIMIT}.`),
    };
  }
  return { ok: true, limit: limit ?? SEARCH_DEFAULT_LIMIT };
}

// ── Strict enum params (F2) ──────────────────────────────────────────

export type StrictEnumResult<T extends string> =
  | { readonly ok: true; readonly value: T | undefined }
  | { readonly ok: false; readonly result: ToolResult };

/**
 * Validate an OPTIONAL enum param and reject a PRESENT-but-invalid value
 * with a clear error, instead of `enumField`'s own silent "any invalid value
 * becomes `undefined`" behavior - which would otherwise make an agent's
 * mistyped enum value indistinguishable from the param being omitted
 * entirely (owner rule: reject out-of-range/invalid values, never silently
 * default). An ABSENT param still resolves to `undefined` ("no filter"),
 * matching `enumField`'s existing behavior for that case exactly - only the
 * present-but-invalid case changes. Used by `handlers/predict.ts` AND
 * `handlers/predict-social.ts`. Scoped to this domain's own handlers - the
 * shared `enumField` helper itself (used by every protocol handler in the
 * repo) is left unchanged; a repo-wide behavior change is a larger,
 * unrequested refactor outside this card.
 */
export function strictEnumField<T extends string>(
  p: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
): StrictEnumResult<T> {
  const raw = p[key];
  if (raw === undefined) return { ok: true, value: undefined };
  const value = enumField(p, key, allowed);
  if (value === undefined) {
    return {
      ok: false,
      result: fail(`Invalid ${key}: ${JSON.stringify(raw)}. ${key} must be one of: ${allowed.join(", ")}.`),
    };
  }
  return { ok: true, value };
}
