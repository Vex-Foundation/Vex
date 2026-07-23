/**
 * Relay `/quote/v2` → normalized bridge-quote adapter (Wave-2 W2).
 *
 * The v2 quote carries per-side USD (`details.currencyIn/Out.amountUsd`) and a
 * top-level `requestId`. This adapter projects the tolerant, untrusted quote
 * into the flat shape the Relay bridge RECORDER consumes, so the handler's
 * migration onto `agent_activity` (W3b) is mechanical: it reads `usdInEst` /
 * `usdOutEst` / `usdSource` / amounts / `requestId` directly and maps them onto
 * `createBridgeActivityIntent`'s expected-fill leg.
 *
 * USD DISCIPLINE (dossier LOW_CONFIDENCE — populated `details{}` keys unverified
 * against a live POST): every USD field is NULLABLE end-to-end and is a
 * marked ESTIMATE (`usdSource`). Provider USD is untrusted input — a value is
 * surfaced ONLY when it parses as a finite decimal, else it degrades to null
 * (validation at the boundary, never a garbage string reaching a USD column).
 *
 * FEES: no single "total fee USD" is derived. Relay's `fees{}` buckets overlap
 * (`relayer` == `relayerGas` + `relayerService`), so a naive sum double-counts;
 * for a financial product that is worse than null. Per-bucket USD is surfaced
 * VERBATIM (numeric buckets only) so the recorder/feed can decide, and every
 * bucket amount is preserved (no truncation — OWNER RULE).
 */

import type { RelayQuoteDetailsSide, RelayQuoteResponse } from "./types.js";

/** Marker stored on the recorded USD estimate so its provenance is queryable. */
export const RELAY_QUOTE_USD_SOURCE = "relay_quote_v2";

/** One projected side (currencyIn / currencyOut) of the quote. USD nullable. */
export interface RelayQuoteSide {
  readonly symbol: string | null;
  readonly decimals: number | null;
  readonly currencyAddress: string | null;
  /** Smallest-unit amount as returned by Relay. */
  readonly amountRaw: string | null;
  /** Human-readable amount as returned by Relay (`amountFormatted`). */
  readonly amountFormatted: string | null;
  /** Per-side USD ESTIMATE — null unless Relay returned a finite decimal. */
  readonly amountUsd: string | null;
}

/** Flat, recorder-facing projection of a validated `/quote/v2` response. */
export interface RelayBridgeQuote {
  /** Authoritative durable intent id (top-level v2), step fallback for display. */
  readonly requestId: string | null;
  /** `details.operation` (`bridge`/`swap`/…) when present — display estimate. */
  readonly operation: string | null;
  /** `details.timeEstimate` seconds when present — display estimate. */
  readonly timeEstimateSeconds: number | null;
  readonly currencyIn: RelayQuoteSide;
  readonly currencyOut: RelayQuoteSide;
  /**
   * Per-bucket fee USD, VERBATIM, numeric buckets only (e.g. `{ relayer: "0.02" }`).
   * No total is derived (buckets overlap). Empty when no bucket had numeric USD.
   */
  readonly feeUsdByBucket: Record<string, string>;
  /** Provenance marker for any recorded USD estimate (see RELAY_QUOTE_USD_SOURCE). */
  readonly usdSource: string;
}

/**
 * Accept a provider USD string ONLY when it is a finite decimal number; return
 * the trimmed verbatim string on success, null otherwise. Untrusted provider
 * input — a non-numeric / infinite / empty value degrades to null rather than
 * flowing into a USD column.
 */
function finiteDecimalOrNull(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(trimmed)) return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? trimmed : null;
}

function strOrNull(raw: unknown): string | null {
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : null;
}

function numberOrNull(raw: unknown): number | null {
  return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
}

function projectSide(side: RelayQuoteDetailsSide | undefined): RelayQuoteSide {
  return {
    symbol: strOrNull(side?.currency?.symbol),
    decimals: numberOrNull(side?.currency?.decimals),
    currencyAddress: strOrNull(side?.currency?.address),
    amountRaw: strOrNull(side?.amount),
    amountFormatted: strOrNull(side?.amountFormatted),
    amountUsd: finiteDecimalOrNull(side?.amountUsd),
  };
}

/**
 * Read a fee bucket's `amountUsd` defensively — `fees{}` is an untrusted record
 * of `unknown`, so guard the bucket is an object carrying a finite-decimal
 * `amountUsd` before surfacing it verbatim.
 */
function bucketUsd(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  return finiteDecimalOrNull((value as { amountUsd?: unknown }).amountUsd);
}

function projectFeeUsd(fees: RelayQuoteResponse["fees"]): Record<string, string> {
  const out: Record<string, string> = {};
  if (!fees) return out;
  for (const [bucket, value] of Object.entries(fees)) {
    const usd = bucketUsd(value);
    if (usd !== null) out[bucket] = usd;
  }
  return out;
}

function firstStepRequestId(quote: RelayQuoteResponse): string | null {
  for (const step of quote.steps) {
    if (step.requestId && step.requestId.length > 0) return step.requestId;
  }
  return null;
}

/**
 * Project a validated `/quote/v2` response into the flat recorder shape. Pure,
 * tolerant, no throws: a quote missing `details{}`/`requestId`/USD yields nulls,
 * not an error (the correlation contract is the fail-closed gate for a missing
 * requestId before signing — see ./correlation).
 */
export function adaptRelayQuote(quote: RelayQuoteResponse): RelayBridgeQuote {
  return {
    requestId: strOrNull(quote.requestId) ?? firstStepRequestId(quote),
    operation: strOrNull(quote.details?.operation),
    timeEstimateSeconds: numberOrNull(quote.details?.timeEstimate),
    currencyIn: projectSide(quote.details?.currencyIn),
    currencyOut: projectSide(quote.details?.currencyOut),
    feeUsdByBucket: projectFeeUsd(quote.fees),
    usdSource: RELAY_QUOTE_USD_SOURCE,
  };
}
