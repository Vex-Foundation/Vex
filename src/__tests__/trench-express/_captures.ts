/**
 * Recorded Trench Express responses — the raw bytes the provider actually sent.
 *
 * The validation tests parse these through the REAL production validators; a
 * hand-written token object would only prove the test's own assumptions, which
 * is exactly how two shipped DexScreener tools stayed broken for months behind a
 * green suite. See `fixtures/live-captures/README.md` for provenance.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export interface Capture {
  readonly endpoint: string;
  readonly capturedAt: string;
  readonly response: unknown;
}

/** The empty-body not-found envelope has a distinct shape (no JSON `response`). */
export interface EmptyBodyCapture {
  readonly endpoint: string;
  readonly capturedAt: string;
  readonly httpStatus: number;
  readonly contentLength: number;
  readonly bodyText: string;
  readonly note: string;
}

function load<T>(name: string): T {
  const path = fileURLToPath(new URL(`./fixtures/live-captures/${name}.json`, import.meta.url));
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

/** Raw `response` body of a standard capture. */
export function captureResponse(name: string): unknown {
  return load<Capture>(name).response;
}

/** The empty-body not-found capture, whole. */
export function notFoundCapture(): EmptyBodyCapture {
  return load<EmptyBodyCapture>("token-not-found-empty-body");
}

/** Named accessors for the captures the tests assert against. */
export const CAPTURES = {
  tokensBonding: "tokens-page0-launched-false",
  tokensGraduated: "tokens-page0-launched-true-graduated",
  tokenSingleGraduated: "token-single-graduated",
  tokenBySymbolBonding: "token-by-symbol-bonding",
  searchWithResults: "search-with-results",
  searchEmpty: "search-empty",
  trades: "trades-page0",
  testnetTokens: "testnet-tokens",
  statsWallet: "stats-wallet",
} as const;
