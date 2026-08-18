/**
 * The HTTP and GraphQL ENVELOPE around a Morpho read: what a request declares,
 * and how a response's outer layers are interpreted before a validator ever
 * sees the payload.
 *
 * Split from `../client.ts` when the positions and activity reads arrived. The
 * seam is a real one rather than a size cut: this module knows about
 * `Retry-After`, `data`/`errors` envelopes and outbound identity, while the
 * client knows about the budget, the read surface and the cache key. They move
 * for different reasons.
 */

import { isRecord } from "../../../utils/validation-helpers.js";

/**
 * Explicit identity on every outbound request (rules/06 - Outbound Provider
 * Requests). Relying on the runtime default is relying on an accident; a
 * KyberSwap-style bot-mitigation edge answers a UA-less request with a 403.
 */
export const USER_AGENT = "Vex-Agent/1.0 (+https://vexlabs.ai)";

export interface GraphqlRequest {
  query: string;
  variables: Record<string, unknown>;
  /** Our own short label, never derived from the response. Used in errors and logs. */
  operation: string;
  ttlMs: number;
  /**
   * Anything OTHER than the GraphQL variables that changes the validated value.
   *
   * `marketById` is the case that forced this field: `includeHistory` and
   * `includeSupplyingVaults` are projection options read after the response
   * arrives, so two calls that differ only in those send IDENTICAL variables
   * while expecting different results. Keying the cache on variables alone
   * served the first call's narrower projection to the second and silently
   * dropped the window the caller asked for - the same class of silent omission
   * rules/90 forbids at the param boundary.
   */
  variant?: string;
  /**
   * Turn an all-`NOT_FOUND` GraphQL error body into a named domain refusal.
   *
   * Morpho answers "no such vault" with HTTP 200, `data: null` and
   * `errors[{status: "NOT_FOUND"}]` (measured 2026-08-14) - byte-for-byte the
   * same envelope as a removed field. Without this hook the two collapse into
   * one message, and an agent told "Morpho rejected the GraphQL query" after
   * typing a wrong address retries a code fix it cannot make. Supplied only by
   * the reads that HAVE a not-found case.
   */
  notFound?: (cause: string) => Error;
}

/** True only when the body carries errors and EVERY one of them is `NOT_FOUND`. */
export function isNotFoundBody(body: unknown): boolean {
  if (!isRecord(body)) return false;
  const errors = body["errors"];
  if (!Array.isArray(errors) || errors.length === 0) return false;
  return errors.every((entry) => isRecord(entry) && entry["status"] === "NOT_FOUND");
}


/** Did the response carry a usable `data` block at all? */
export function hasData(body: unknown): boolean {
  return isRecord(body) && body["data"] !== null && body["data"] !== undefined;
}

/** Parse `Retry-After` (delta-seconds or HTTP-date) into whole seconds. */
export function parseRetryAfterSeconds(header: string | null | undefined): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.floor(seconds);
  const date = Date.parse(header);
  if (!Number.isNaN(date)) return Math.max(0, Math.floor((date - Date.now()) / 1_000));
  return undefined;
}
